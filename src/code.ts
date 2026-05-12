/**
 * code.ts
 *
 * Runs in Figma's plugin sandbox.
 * Uses figma.* API and fetch() (no DOM).
 * Communicates with ui.html exclusively via postMessage.
 */

// --- Incoming messages (UI → main) ---

/** Discriminated union of all messages the UI may send to the plugin main thread. */
type PluginMessage =
  | { type: 'LOAD_KEY' }
  | { type: 'SAVE_KEY'; key: string }
  | { type: 'LOAD_BRAND' }
  | { type: 'SAVE_BRAND'; brandId: string }
  | { type: 'GET_SELECTION' }
  | { type: 'INSERT_IMAGE'; imageUrl: string; prompt: string; aspectRatio: string }
  | { type: 'REPLACE_IMAGE'; nodeId: string; imageUrl: string }
  | {
      type: 'BATCH_INSERT';
      items: Array<{ frameId: string; imageUrl: string; prompt: string; aspectRatio: string }>;
    }
  | { type: 'GET_SELECTED_IMAGE_URL' }
  | { type: 'FETCH_IMAGE_DATA'; url: string }
  | { type: 'CLOSE' };

/** Payload describing the current canvas selection for the UI. */
type SelectionInfoMessage =
  | {
      type: 'FRAME_SELECTED';
      frameId: string;
      name: string;
      width: number;
      height: number;
    }
  | {
      type: 'IMAGE_LAYER_SELECTED';
      nodeId: string;
      name: string;
      width: number;
      height: number;
    }
  | {
      type: 'MULTI_FRAME_SELECTED';
      frames: Array<{ id: string; name: string; width: number; height: number }>;
    }
  | { type: 'NO_FRAME_SELECTED' };

figma.showUI(__html__, { width: 420, height: 760, title: 'Bloom' });

/**
 * Reports a handler failure to the UI with a stable message shape.
 */
function postPluginError(operation: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  figma.ui.postMessage({ type: 'PLUGIN_ERROR', operation, message });
}

/**
 * Returns true if the node behaves like a frame for insertion targets (frame, component root, instance).
 */
function isFrameLike(
  node: SceneNode
): node is FrameNode | ComponentNode | InstanceNode {
  return node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE';
}

/**
 * Returns true if the node has at least one visible image fill.
 */
function hasImageFill(node: SceneNode): boolean {
  if (!('fills' in node) || node.fills === figma.mixed) {
    return false;
  }
  return node.fills.some((p) => p.type === 'IMAGE' && p.visible !== false);
}

/**
 * Reads the current page selection and classifies it for Bloom workflows.
 */
function analyzeSelection(): SelectionInfoMessage {
  const sel = figma.currentPage.selection;

  if (sel.length === 0) {
    return { type: 'NO_FRAME_SELECTED' };
  }

  const frameLikes = sel.filter(isFrameLike);

  if (sel.length >= 2) {
    if (frameLikes.length === sel.length && frameLikes.length >= 2) {
      return {
        type: 'MULTI_FRAME_SELECTED',
        frames: frameLikes.map((n) => ({
          id: n.id,
          name: n.name,
          width: n.width,
          height: n.height,
        })),
      };
    }
    return { type: 'NO_FRAME_SELECTED' };
  }

  const one = sel[0];
  if (isFrameLike(one)) {
    return {
      type: 'FRAME_SELECTED',
      frameId: one.id,
      name: one.name,
      width: one.width,
      height: one.height,
    };
  }

  if (hasImageFill(one)) {
    return {
      type: 'IMAGE_LAYER_SELECTED',
      nodeId: one.id,
      name: one.name,
      width: 'width' in one ? one.width : 0,
      height: 'height' in one ? one.height : 0,
    };
  }

  return { type: 'NO_FRAME_SELECTED' };
}

/**
 * Pushes the current selection classification to the UI.
 * Call on plugin open and whenever the selection changes.
 */
async function sendSelectionInfo(): Promise<void> {
  figma.ui.postMessage(analyzeSelection());
}

/**
 * Parses "W:H" aspect ratio strings into a width/height pair for layout math.
 */
function parseAspectRatio(aspectRatio: string): { w: number; h: number } {
  const m = aspectRatio.trim().match(/^(\d+)\s*:\s*(\d+)$/);
  if (m) {
    return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
  }
  return { w: 1, h: 1 };
}

/**
 * Computes a reasonable rectangle size from aspect ratio (max width 400px).
 */
function sizeForAspectRatio(aspectRatio: string): { width: number; height: number } {
  const { w, h } = parseAspectRatio(aspectRatio);
  const base = 400;
  const width = base;
  const height = Math.max(1, Math.round((base * h) / w));
  return { width, height };
}

/**
 * Builds the default Bloom layer name from prompt, ratio, and time.
 */
function buildBloomLayerName(prompt: string, aspectRatio: string): string {
  const snippet = (prompt.trim() || 'Image').slice(0, 48);
  const time = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `Bloom: ${snippet} · ${aspectRatio} · ${time}`;
}

/**
 * Downloads a remote image URL to raw bytes (PNG/JPEG/GIF) for figma.createImage.
 */
async function downloadUrlToBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download image (HTTP ${res.status})`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Converts image bytes to a data URL for postMessage to the UI.
 */
function bytesToDataUrl(bytes: Uint8Array): string {
  let mime = 'application/octet-stream';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mime = 'image/jpeg';
  } else if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    mime = 'image/png';
  } else if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    mime = 'image/gif';
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, Array.from(sub));
  }
  const b64 = btoa(binary);
  return `data:${mime};base64,${b64}`;
}

/**
 * Creates a rectangle with an image fill and returns it (not yet parented).
 */
async function createImageRectangle(imageUrl: string, prompt: string, aspectRatio: string): Promise<RectangleNode> {
  const bytes = await downloadUrlToBytes(imageUrl);
  const image = figma.createImage(bytes);
  const { width, height } = sizeForAspectRatio(aspectRatio);
  const rect = figma.createRectangle();
  rect.name = buildBloomLayerName(prompt, aspectRatio);
  rect.resize(width, height);
  rect.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }];
  return rect;
}

/**
 * Parents and centers a node inside a frame-like container, or on the current page at the viewport center.
 */
function placeNodeInTarget(rect: SceneNode, targetFrame: FrameNode | ComponentNode | InstanceNode | null): void {
  if (targetFrame) {
    targetFrame.appendChild(rect);
    rect.x = (targetFrame.width - rect.width) / 2;
    rect.y = (targetFrame.height - rect.height) / 2;
  } else {
    figma.currentPage.appendChild(rect);
    const c = figma.viewport.center;
    rect.x = c.x - rect.width / 2;
    rect.y = c.y - rect.height / 2;
  }
}

/**
 * If a single frame-like node is selected, returns it as the insert target; otherwise null (canvas center).
 */
function getInsertTargetFrame(): FrameNode | ComponentNode | InstanceNode | null {
  const sel = figma.currentPage.selection;
  if (sel.length === 1 && isFrameLike(sel[0])) {
    return sel[0];
  }
  return null;
}

/**
 * Returns the first visible image hash on a node, or null.
 */
function getFirstImageHash(node: SceneNode): string | null {
  if (!('fills' in node) || node.fills === figma.mixed) {
    return null;
  }
  for (const p of node.fills) {
    if (p.type === 'IMAGE' && p.visible !== false && typeof p.imageHash === 'string') {
      return p.imageHash;
    }
  }
  return null;
}

/** Publishes the initial selection state as soon as the plugin UI is shown. */
void sendSelectionInfo();

/**
 * Keeps the UI aligned with the canvas whenever the user changes their selection.
 */
figma.on('selectionchange', () => {
  void sendSelectionInfo();
});

/**
 * Routes `postMessage` payloads from `ui.html` to the appropriate Figma document operations.
 * Each handler runs inside its own try/catch so one failure does not break the plugin.
 */
figma.ui.onmessage = async (raw: unknown) => {
  if (!raw || typeof raw !== 'object' || !('type' in raw) || typeof (raw as { type: unknown }).type !== 'string') {
    return;
  }
  const msg = raw as PluginMessage;

  switch (msg.type) {
    /**
     * LOAD_KEY
     * Store and retrieve the Bloom API key using figma.clientStorage.
     * Never use localStorage — it does not work in Figma plugins.
     */
    case 'LOAD_KEY': {
      try {
        const storedKey = await figma.clientStorage.getAsync('bloom_api_key');
        figma.ui.postMessage({ type: 'KEY_LOADED', key: typeof storedKey === 'string' ? storedKey : null });
      } catch (e) {
        postPluginError('LOAD_KEY', e);
      }
      break;
    }

    /**
     * SAVE_KEY
     * Store and retrieve the Bloom API key using figma.clientStorage.
     * Never use localStorage — it does not work in Figma plugins.
     */
    case 'SAVE_KEY': {
      try {
        await figma.clientStorage.setAsync('bloom_api_key', msg.key);
        figma.ui.postMessage({ type: 'KEY_SAVED' });
      } catch (e) {
        postPluginError('SAVE_KEY', e);
      }
      break;
    }

    /**
     * LOAD_BRAND
     * Store and retrieve the selected brand ID.
     */
    case 'LOAD_BRAND': {
      try {
        const storedBrandId = await figma.clientStorage.getAsync('bloom_brand_id');
        figma.ui.postMessage({
          type: 'BRAND_LOADED',
          brandId: typeof storedBrandId === 'string' ? storedBrandId : null,
        });
      } catch (e) {
        postPluginError('LOAD_BRAND', e);
      }
      break;
    }

    /**
     * SAVE_BRAND
     * Store and retrieve the selected brand ID.
     */
    case 'SAVE_BRAND': {
      try {
        await figma.clientStorage.setAsync('bloom_brand_id', msg.brandId);
      } catch (e) {
        postPluginError('SAVE_BRAND', e);
      }
      break;
    }

    /**
     * GET_SELECTION
     * Reads what the user has selected on the Figma canvas.
     * Sends back one of:
     *   FRAME_SELECTED — single frame selected
     *   IMAGE_LAYER_SELECTED — a layer with an image fill selected
     *   MULTI_FRAME_SELECTED — multiple frames selected (batch mode)
     *   NO_FRAME_SELECTED — nothing useful selected
     */
    case 'GET_SELECTION': {
      try {
        figma.ui.postMessage(analyzeSelection());
      } catch (e) {
        postPluginError('GET_SELECTION', e);
      }
      break;
    }

    /**
     * INSERT_IMAGE
     * Downloads an image URL, creates a Figma image,
     * creates a rectangle with that image as fill,
     * and inserts it into the selected frame or canvas center.
     * Names the layer: "Bloom: {prompt snippet} · {ratio} · {time}"
     */
    case 'INSERT_IMAGE': {
      try {
        const rect = await createImageRectangle(msg.imageUrl, msg.prompt, msg.aspectRatio);
        const target = getInsertTargetFrame();
        placeNodeInTarget(rect, target);
        figma.currentPage.selection = [rect];
        figma.viewport.scrollAndZoomIntoView([rect]);
      } catch (e) {
        postPluginError('INSERT_IMAGE', e);
      }
      break;
    }

    /**
     * REPLACE_IMAGE
     * Downloads an image URL and replaces the fill
     * of an existing layer (by nodeId) with the new image.
     */
    case 'REPLACE_IMAGE': {
      try {
        const node = await figma.getNodeByIdAsync(msg.nodeId);
        if (!node || !('fills' in node)) {
          throw new Error('Node not found or does not support fills');
        }
        if (node.fills === figma.mixed) {
          throw new Error('Node fills are mixed — cannot replace image');
        }
        const bytes = await downloadUrlToBytes(msg.imageUrl);
        const image = figma.createImage(bytes);
        const fills: Paint[] = [...node.fills];
        let replaced = false;
        for (let i = 0; i < fills.length; i++) {
          if (fills[i].type === 'IMAGE') {
            fills[i] = { type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' };
            replaced = true;
            break;
          }
        }
        if (!replaced) {
          fills.push({ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' });
        }
        node.fills = fills;
        figma.currentPage.selection = [node as SceneNode];
      } catch (e) {
        postPluginError('REPLACE_IMAGE', e);
      }
      break;
    }

    /**
     * BATCH_INSERT
     * Inserts images into multiple frames at once.
     * Sends BATCH_ITEM_DONE after each frame is filled.
     * Sends BATCH_COMPLETE when all frames are done.
     */
    case 'BATCH_INSERT': {
      try {
        for (const item of msg.items) {
          try {
            const frameNode = await figma.getNodeByIdAsync(item.frameId);
            if (!frameNode || !isFrameLike(frameNode as SceneNode)) {
              throw new Error(`Invalid frame id: ${item.frameId}`);
            }
            const frame = frameNode as FrameNode | ComponentNode | InstanceNode;
            const rect = await createImageRectangle(item.imageUrl, item.prompt, item.aspectRatio);
            placeNodeInTarget(rect, frame);
            figma.ui.postMessage({ type: 'BATCH_ITEM_DONE', frameId: item.frameId });
          } catch (itemErr) {
            figma.ui.postMessage({
              type: 'BATCH_ITEM_DONE',
              frameId: item.frameId,
              error: itemErr instanceof Error ? itemErr.message : String(itemErr),
            });
          }
        }
        figma.ui.postMessage({ type: 'BATCH_COMPLETE' });
      } catch (e) {
        postPluginError('BATCH_INSERT', e);
      }
      break;
    }

    /**
     * GET_SELECTED_IMAGE_URL
     * Reads the image fill from the selected layer,
     * converts it to a base64 data URL,
     * and sends it back as SELECTED_IMAGE_URL.
     * Used for style reference feature.
     */
    case 'GET_SELECTED_IMAGE_URL': {
      try {
        const sel = figma.currentPage.selection;
        if (sel.length !== 1) {
          figma.ui.postMessage({
            type: 'SELECTED_IMAGE_URL',
            dataUrl: null,
            error: 'Select a single layer with an image fill',
          });
          break;
        }
        const node = sel[0];
        const hash = getFirstImageHash(node);
        if (!hash) {
          figma.ui.postMessage({
            type: 'SELECTED_IMAGE_URL',
            dataUrl: null,
            error: 'No image fill found on the selected layer',
          });
          break;
        }
        const image = figma.getImageByHash(hash);
        if (!image) {
          figma.ui.postMessage({
            type: 'SELECTED_IMAGE_URL',
            dataUrl: null,
            error: 'Could not resolve image from fill',
          });
          break;
        }
        const bytes = await image.getBytesAsync();
        const dataUrl = bytesToDataUrl(bytes);
        figma.ui.postMessage({ type: 'SELECTED_IMAGE_URL', dataUrl });
      } catch (e) {
        postPluginError('GET_SELECTED_IMAGE_URL', e);
      }
      break;
    }

    /**
     * FETCH_IMAGE_DATA
     * Downloads an image by URL, converts to base64 data URL.
     * Used as fallback when ui.html cannot display an image directly
     * due to CORS restrictions on Bloom CDN URLs.
     */
    case 'FETCH_IMAGE_DATA': {
      try {
        const bytes = await downloadUrlToBytes(msg.url);
        const dataUrl = bytesToDataUrl(bytes);
        figma.ui.postMessage({ type: 'FETCH_IMAGE_DATA_RESULT', dataUrl });
      } catch (e) {
        postPluginError('FETCH_IMAGE_DATA', e);
      }
      break;
    }

    /**
     * CLOSE
     * Shuts down the plugin process.
     */
    case 'CLOSE': {
      try {
        figma.closePlugin();
      } catch (e) {
        postPluginError('CLOSE', e);
      }
      break;
    }

    /**
     * Unknown message types are ignored so the UI can extend the protocol later
     * without breaking older plugin builds.
     */
    default: {
      break;
    }
  }
};
