/**
 * @file DOM rendering and sync helpers for the Bloom plugin UI.
 *
 * Pure DOM functions: they read from `state`, update the DOM, and post
 * messages to code.ts. They do NOT trigger API calls or view transitions.
 */

import { state, postToCode, PROMPT_MAX } from './state';
import { getImageUrl } from './client';

// ---------------------------------------------------------------------------
// Generator controls
// ---------------------------------------------------------------------------

/**
 * Maps pixel dimensions to the closest Bloom aspect ratio.
 * Tolerance: ±8 % for square/portrait, ±10 % for landscape.
 * Falls back to "1:1" when no candidate matches.
 */
export function detectAspectRatio(w: number, h: number): string {
  if (!(w > 0) || !(h > 0)) return '1:1';
  const α = w / h;
  const candidates = [
    { id: '1:1', r: 1, tol: 0.08 },
    { id: '4:5', r: 4 / 5, tol: 0.08 },
    { id: '9:16', r: 9 / 16, tol: 0.08 },
    { id: '16:9', r: 16 / 9, tol: 0.1 },
  ];
  const matches = candidates
    .map((c) => ({ id: c.id, dist: Math.abs(α - c.r), relErr: Math.abs(α - c.r) / c.r, tol: c.tol }))
    .filter((c) => c.relErr <= c.tol)
    .sort((a, b) => a.dist - b.dist);
  return matches.length > 0 ? matches[0].id : '1:1';
}

/** Returns the aspect ratio to send to Bloom: the manual selection or auto-detected from frame dims. */
export function getEffectiveAspectRatio(): string {
  if (state.selectedRatio !== 'auto') return state.selectedRatio;
  if (state.frameWidth != null && state.frameHeight != null && state.frameWidth > 0 && state.frameHeight > 0) {
    return detectAspectRatio(state.frameWidth, state.frameHeight);
  }
  return '1:1';
}

/** Renders variant count buttons (1–5), highlighting the active count. */
export function renderVariants(): void {
  const host = document.getElementById('variant-buttons');
  if (!host) return;
  host.innerHTML = '';
  for (let n = 1; n <= 5; n++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    const active = state.variantCount === n;
    btn.className = 'variant-btn' + (active ? ' is-selected' : '');
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.textContent = String(n);
    btn.addEventListener('click', () => {
      state.variantCount = n;
      renderVariants();
    });
    host.appendChild(btn);
  }
}

/** Renders aspect-ratio pills (Auto | 1:1 | 4:5 | 9:16 | 16:9), highlighting the selection. */
export function renderRatios(): void {
  const host = document.getElementById('ratio-pills');
  if (!host) return;
  const labels = [
    { value: 'auto', label: 'Auto' },
    { value: '1:1', label: '1:1' },
    { value: '4:5', label: '4:5' },
    { value: '9:16', label: '9:16' },
    { value: '16:9', label: '16:9' },
  ];
  host.innerHTML = '';
  for (const entry of labels) {
    const btn = document.createElement('button');
    btn.type = 'button';
    const active = state.selectedRatio === entry.value;
    btn.className = 'pill' + (active ? ' is-selected' : '');
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.setAttribute('data-ratio', entry.value);
    btn.textContent = entry.label;
    btn.addEventListener('click', () => {
      state.selectedRatio = entry.value;
      renderRatios();
    });
    host.appendChild(btn);
  }
}

/**
 * Updates the frame-pill label to reflect the current canvas selection:
 * frame name + dimensions, replace mode, batch mode, or "No frame selected".
 */
export function renderFramePill(): void {
  const el = document.getElementById('frame-pill');
  if (!el) return;
  if (state.isReplaceMode) {
    el.textContent = 'Replace mode';
  } else if (state.isBatchMode && state.batchFrames.length > 0) {
    el.textContent = `Batch mode — ${state.batchFrames.length} frames`;
  } else if (state.frameWidth != null && state.frameHeight != null && state.frameName) {
    el.textContent =
      `${state.frameName} · ${Math.round(state.frameWidth)}×${Math.round(state.frameHeight)}px`;
  } else if (state.frameWidth != null && state.frameHeight != null) {
    el.textContent = `${Math.round(state.frameWidth)}×${Math.round(state.frameHeight)}px`;
  } else {
    el.textContent = 'No frame selected';
  }
}

/** Syncs the prompt character counter, truncates at max, and enables/disables Generate. */
export function syncPromptUi(): void {
  const ta = document.getElementById('prompt-input') as HTMLTextAreaElement | null;
  const countEl = document.getElementById('prompt-count');
  const btn = document.getElementById('btn-generate') as HTMLButtonElement | null;
  let raw = ta ? String(ta.value ?? '') : '';
  if (raw.length > PROMPT_MAX && ta) {
    ta.value = raw.slice(0, PROMPT_MAX);
    raw = ta.value;
  }
  if (countEl) countEl.textContent = `${raw.length}/500`;
  if (btn) btn.disabled = state._generationRunning || raw.trim().length === 0;
}

/** Shows or hides the style-reference preview image and syncs the Clear button. */
export function updateStyleRefUi(): void {
  const wrap = document.getElementById('style-ref-preview-wrap');
  const img = document.getElementById('style-ref-preview') as HTMLImageElement | null;
  const clearBtn = document.getElementById('btn-style-ref-clear') as HTMLButtonElement | null;
  if (state.styleReferenceDataUrl && img && wrap) {
    img.src = state.styleReferenceDataUrl;
    wrap.classList.remove('is-hidden');
    if (clearBtn) clearBtn.disabled = false;
  } else {
    wrap?.classList.add('is-hidden');
    if (img) img.removeAttribute('src');
    if (clearBtn) clearBtn.disabled = true;
  }
  syncPromptUi();
}

/** Sets the heading text of the generating spinner view. */
export function setGeneratingTitle(title?: string): void {
  const el = document.getElementById('gen-loading-title');
  if (el) el.textContent = title ?? 'Generating…';
}

/** No-op placeholder; reserved for a future determinate progress bar. */
export function setGeneratingProgress(_pct?: number): void {}

// ---------------------------------------------------------------------------
// Results grid
// ---------------------------------------------------------------------------

/**
 * Builds the thumbnail `<img>` for a result cell.
 * Proactively posts FETCH_IMAGE_DATA to bypass iframe CORS, then falls back
 * to a direct src load.
 */
function buildThumbImg(
  idStr: string,
  imageUrl: string,
  altText: string,
  loadWrap: HTMLElement,
): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'image-cell__thumb';
  img.alt = altText;
  img.decoding = 'async';
  img.width = 400;
  img.height = 400;
  img.onload = () => loadWrap.classList.add('is-hidden');

  const resolved = getImageUrl(imageUrl);
  if (resolved) {
    if (!resolved.startsWith('data:')) {
      postToCode({ type: 'FETCH_IMAGE_DATA', imageId: idStr, imageUrl: resolved });
    }
    img.src = resolved;
    img.onerror = () => onThumbImgError(idStr, resolved);
  } else {
    loadWrap.classList.add('is-hidden');
  }
  return img;
}

/**
 * Creates a complete image-cell `<button>` for results or library grids.
 */
function buildImageCell(
  idStr: string,
  imageUrl: string,
  aspectRatio: string,
  altText: string,
  isSelected: boolean,
  onClick: () => void,
  onDblClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'image-cell' + (isSelected ? ' is-selected' : '');
  btn.setAttribute('role', 'listitem');
  btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
  btn.setAttribute('data-image-id', idStr);
  if (btn.dataset) btn.dataset.imageId = idStr;

  const badge = document.createElement('span');
  badge.className = 'image-cell__badge';
  badge.textContent = aspectRatio || '—';

  const loadWrap = document.createElement('div');
  loadWrap.className = 'image-cell__loading';
  const sp = document.createElement('div');
  sp.className = 'spinner';
  sp.setAttribute('aria-hidden', 'true');
  loadWrap.appendChild(sp);

  btn.appendChild(badge);
  btn.appendChild(loadWrap);

  const resolved = getImageUrl(imageUrl);
  if (resolved) {
    btn.appendChild(buildThumbImg(idStr, imageUrl, altText, loadWrap));
  } else {
    loadWrap.classList.add('is-hidden');
    btn.classList.add('image-cell--unavailable');
    const ph = document.createElement('span');
    ph.className = 'image-cell__unavailable';
    ph.textContent = 'Image unavailable';
    btn.appendChild(ph);
  }

  btn.addEventListener('click', onClick);
  btn.addEventListener('dblclick', (ev) => { ev.preventDefault(); onDblClick(); });
  return btn;
}

/**
 * Renders generationResults into the results grid and auto-selects the first image.
 */
export function showResults(onZoom: (idx: number) => void): void {
  const grid = document.getElementById('results-grid');
  if (!grid) return;
  grid.innerHTML = '';
  grid.classList.toggle('results-grid--single', state.generationResults.length <= 1);
  state.selectedImageId =
    state.generationResults.length > 0 ? state.generationResults[0].id : null;

  state.generationResults.forEach((r, idx) => {
    const idStr = String(r.id ?? '');
    const cell = buildImageCell(
      idStr,
      r.imageUrl,
      r.aspectRatio,
      `Generated variant ${idx + 1}`,
      r.id === state.selectedImageId,
      () => { state.selectedImageId = r.id; syncResultsGridSelection(); },
      () => onZoom(idx),
    );
    grid.appendChild(cell);
  });

  const regenBtn = document.getElementById('btn-regenerate') as HTMLButtonElement | null;
  if (regenBtn) regenBtn.disabled = !state.lastGenerateSnapshot;
}

/** Applies the current selectedImageId highlight to all cells in the results grid. */
export function syncResultsGridSelection(): void {
  const grid = document.getElementById('results-grid');
  if (!grid) return;
  grid.querySelectorAll<HTMLElement>('.image-cell').forEach((cell) => {
    const on = cell.getAttribute('data-image-id') === state.selectedImageId;
    cell.classList.toggle('is-selected', on);
    cell.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

/**
 * Renders libraryRows into the library grid.
 */
export function renderLibraryGrid(onZoom: (idx: number) => void): void {
  const grid = document.getElementById('library-grid');
  if (!grid) return;
  grid.innerHTML = '';
  grid.classList.toggle('results-grid--single', state.libraryRows.length <= 1);

  state.libraryRows.forEach((r, idx) => {
    const idStr = String(r.id ?? '');
    const cell = buildImageCell(
      idStr,
      r.imageUrl,
      r.aspectRatio,
      `Library image ${idx + 1}`,
      r.id === state.librarySelectedId,
      () => { state.librarySelectedId = r.id; syncLibraryGridSelection(); },
      () => onZoom(idx),
    );
    grid.appendChild(cell);
  });
}

/** Applies the current librarySelectedId highlight to all cells in the library grid. */
export function syncLibraryGridSelection(): void {
  const grid = document.getElementById('library-grid');
  if (!grid) return;
  grid.querySelectorAll<HTMLElement>('.image-cell').forEach((cell) => {
    const on = cell.getAttribute('data-image-id') === state.librarySelectedId;
    cell.classList.toggle('is-selected', on);
    cell.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

// ---------------------------------------------------------------------------
// Brand list
// ---------------------------------------------------------------------------

/** Human-readable label for a raw brand status string from the API. */
export function formatBrandStatus(status: string): string {
  const labels: Record<string, string> = {
    ready: 'Ready',
    analyzing: 'Analyzing',
    logo_required: 'Logo required',
    failed: 'Failed',
  };
  return labels[status] ?? (status ? String(status) : '');
}

/** Renders placeholder skeleton cards while the brand list is loading. */
export function renderBrandSkeletons(container: HTMLElement, count: number): void {
  container.innerHTML = '';
  for (let s = 0; s < count; s++) {
    const wrap = document.createElement('div');
    wrap.className = 'brand-skeleton-card';
    wrap.setAttribute('role', 'presentation');
    const a = document.createElement('span');
    a.className = 'skeleton skeleton-line';
    const b = document.createElement('span');
    b.className = 'skeleton skeleton-line skeleton-line--narrow';
    wrap.appendChild(a);
    wrap.appendChild(b);
    container.appendChild(wrap);
  }
}

/** Enables or disables the brand Continue button. */
export function setBrandContinueEnabled(enabled: boolean): void {
  const btn = document.getElementById('btn-brand-continue') as HTMLButtonElement | null;
  if (btn) btn.disabled = !enabled;
}

/** Updates selection highlight and Continue button based on state.selectedBrandId. */
export function syncBrandSelectionUi(): void {
  const list = document.getElementById('brand-list');
  if (!list) return;
  list.querySelectorAll<HTMLElement>('.brand-card').forEach((card) => {
    const on = !!state.selectedBrandId && card.getAttribute('data-brand-id') === state.selectedBrandId;
    card.classList.toggle('is-selected', on);
    card.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  setBrandContinueEnabled(!!state.selectedBrandId);
}

/** Shows or hides the brand-picker error message. */
export function setBrandListError(text: string): void {
  const el = document.getElementById('brand-list-error');
  if (!el) return;
  el.textContent = text ?? '';
  el.classList.toggle('is-visible', !!text);
}

/** Shows or hides the "Learning your brand…" onboarding status line. */
export function setOnboardStatusVisible(visible: boolean): void {
  const el = document.getElementById('brand-onboard-status');
  if (!el) return;
  el.classList.toggle('is-visible', visible);
}

// ---------------------------------------------------------------------------
// Setup view
// ---------------------------------------------------------------------------

/** Shows or clears the inline error under the API key field. */
export function setApiKeyError(text: string): void {
  const el = document.getElementById('api-key-error');
  if (!el) return;
  el.textContent = text ?? '';
  el.classList.toggle('is-visible', !!text);
}

/** Disables the Connect button and updates its label during async validation. */
export function setConnectLoading(isLoading: boolean): void {
  const btn = document.getElementById('btn-setup-connect') as HTMLButtonElement | null;
  if (!btn) return;
  btn.disabled = isLoading;
  btn.textContent = isLoading ? 'Checking…' : 'Connect';
}

// ---------------------------------------------------------------------------
// Insert button flash
// ---------------------------------------------------------------------------

/**
 * Temporarily changes Insert button labels to a confirmation string,
 * then restores the originals after 1.8 s.
 */
export function flashInsertButton(label: string): void {
  if (state._insertFlashTimer) clearTimeout(state._insertFlashTimer);
  const ids = ['btn-insert-selected', 'btn-library-insert'];
  const pairs: { el: HTMLButtonElement; def: string }[] = [];
  for (const id of ids) {
    const b = document.getElementById(id) as HTMLButtonElement | null;
    if (!b) continue;
    pairs.push({ el: b, def: b.getAttribute('data-default-label') ?? 'Insert selected' });
    b.textContent = label;
  }
  state._insertFlashTimer = setTimeout(() => {
    for (const { el, def } of pairs) el.textContent = def;
    state._insertFlashTimer = null;
  }, 1800);
}

// ---------------------------------------------------------------------------
// Image cell error handling
// ---------------------------------------------------------------------------

/**
 * Finds a result/library cell button by Bloom image id.
 * Avoids querySelector escaping issues for unusual id characters.
 */
export function findResultCellByImageId(imageId: string): Element | null {
  const idStr = imageId != null ? String(imageId) : '';
  if (!idStr) return null;
  const grids = [
    document.getElementById('results-grid'),
    document.getElementById('library-grid'),
  ];
  for (const grid of grids) {
    if (!grid) continue;
    const cells = grid.querySelectorAll('.image-cell');
    for (const cell of Array.from(cells)) {
      if (String(cell.getAttribute('data-image-id') ?? '') === idStr) return cell;
    }
  }
  return null;
}

/**
 * Marks a thumbnail cell as failed/unavailable.
 * Called after IMAGE_DATA_ERROR or a failed data-URL load.
 */
export function markImageCellUnavailable(imageId: string | number): void {
  const cell = findResultCellByImageId(String(imageId));
  if (!cell) return;
  cell.classList.add('image-cell--unavailable');
  const lw = cell.querySelector('.image-cell__loading');
  if (lw) lw.classList.add('is-hidden');
  let ph = cell.querySelector('.image-cell__unavailable');
  if (!ph) {
    ph = document.createElement('span');
    ph.className = 'image-cell__unavailable';
    cell.appendChild(ph);
  }
  ph.textContent = 'Image unavailable';
}

/**
 * Handles `<img>` onerror for results and library thumbnails.
 * For data URLs the cell is marked unavailable immediately;
 * for remote URLs the FETCH_IMAGE_DATA path handles the error via IMAGE_DATA_ERROR.
 */
export function onThumbImgError(imageId: string, resolved: string): void {
  if (resolved.startsWith('data:')) {
    markImageCellUnavailable(imageId);
  }
}
