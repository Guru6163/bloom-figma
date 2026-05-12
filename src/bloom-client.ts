/**
 * bloom-client.ts
 *
 * Bloom REST API client for use inside the Figma plugin UI.
 * Success JSON is validated against OpenAPI 3.1.1 shapes in `bloom-api-schema.ts`.
 * https://www.trybloom.ai/api/v1/docs
 */

import {
  extractBloomErrorMessage,
  parseBrandDetailEnvelope,
  parseBrandsListEnvelope,
  parseCreditsEnvelope,
  parseEditAcceptedEnvelope,
  parseGenerationAcceptedEnvelope,
  parseImagesListEnvelope,
  parseOnboardBrandEnvelope,
  toBloomBrand,
  effectiveImageGenStatus,
  type BloomBrand,
  type BloomImageRow,
  type BloomImagesListData,
  type BloomImageGenStatus,
  type BloomImageSource,
  type BloomImageActionType,
} from './bloom-api-schema';

export type {
  BloomBrand,
  BloomImageRow,
  BloomImageListItem,
  BloomImageGetData,
  BloomAspectRatio,
  BloomImageSource,
  BloomImageActionType,
  BloomImageGenStatus,
  BloomImagesListData,
} from './bloom-api-schema';

export { parseGetImageEnvelope, BloomApiParseError } from './bloom-api-schema';

const BLOOM_BASE = 'https://www.trybloom.ai/api/v1';

/**
 * Parses JSON for a successful (2xx) Bloom HTTP response.
 * On success returns `unknown` only at the wire boundary — callers must pass
 * the value through a `parse*Envelope` function in `bloom-api-schema.ts`.
 */
async function bloomFetchOkJson(path: string, apiKey: string, options: RequestInit = {}): Promise<unknown> {
  try {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${BLOOM_BASE}${normalizedPath}`;

    const headers = new Headers(options.headers);
    headers.set('x-api-key', apiKey);
    if (options.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const res = await fetch(url, { ...options, headers });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }

    if (!res.ok) {
      const detail = extractBloomErrorMessage(body) ?? (typeof body === 'string' ? body : res.statusText);
      throw new Error(`Bloom API ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
    }

    return body;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Bloom API')) {
      throw e;
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`We couldn't reach Bloom. Check your network and try again. ${msg}`);
  }
}

function isTerminalGenStatus(s: ReturnType<typeof effectiveImageGenStatus>): boolean {
  return s === 'completed' || s === 'failed';
}

/**
 * Validates an API key by attempting to list brands and verifying the response envelope.
 */
export async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    const body = await bloomFetchOkJson('/brands?limit=1', apiKey, { method: 'GET' });
    parseBrandsListEnvelope(body);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("We couldn't reach Bloom")) {
      throw new Error(msg);
    }
    return false;
  }
}

/**
 * Returns all brands for this API key (cursor pagination via `nextCursor` / `hasMore`).
 */
export async function listBrands(apiKey: string): Promise<BloomBrand[]> {
  const out: BloomBrand[] = [];
  let cursor: string | undefined;

  for (;;) {
    const qs = new URLSearchParams();
    qs.set('limit', '100');
    if (cursor) qs.set('cursor', cursor);

    const body = await bloomFetchOkJson(`/brands?${qs.toString()}`, apiKey, { method: 'GET' });
    const page = parseBrandsListEnvelope(body);
    for (const item of page.brands) {
      out.push(toBloomBrand(item));
    }

    const next = typeof page.nextCursor === 'string' && page.nextCursor.length > 0 ? page.nextCursor : undefined;
    if (!page.hasMore || !next || page.brands.length === 0) break;
    cursor = next;
  }

  return out;
}

/**
 * POST /brands — returns 202; `data` contains id, status, optional logoError.
 */
export async function onboardBrand(apiKey: string, url: string): Promise<BloomBrand> {
  const body = await bloomFetchOkJson('/brands', apiKey, {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
  const d = parseOnboardBrandEnvelope(body);
  return toBloomBrand({
    id: d.id,
    name: '',
    url,
    status: d.status,
    logoError: d.logoError,
  });
}

/**
 * GET /brands/{id}
 */
export async function getBrand(apiKey: string, brandId: string): Promise<BloomBrand> {
  const body = await bloomFetchOkJson(`/brands/${encodeURIComponent(brandId)}`, apiKey, { method: 'GET' });
  const detail = parseBrandDetailEnvelope(body);
  return toBloomBrand(detail);
}

/**
 * POST /images/generations — returns image IDs; response includes variantGroupId and status.
 */
export async function generateImages(
  apiKey: string,
  brandSessionId: string,
  prompt: string,
  aspectRatio: string,
  variantCount: number
): Promise<string[]> {
  const clamped = Math.min(5, Math.max(1, Math.floor(variantCount)));
  const body = await bloomFetchOkJson('/images/generations', apiKey, {
    method: 'POST',
    body: JSON.stringify({
      prompt,
      brandSessionId,
      aspectRatio,
      variantCount: clamped,
    }),
  });
  const accepted = parseGenerationAcceptedEnvelope(body);
  return accepted.ids;
}

/**
 * POST /images/{id}/edit
 */
export async function editImage(
  apiKey: string,
  brandSessionId: string,
  imageId: string,
  prompt: string
): Promise<string[]> {
  const body = await bloomFetchOkJson(`/images/${encodeURIComponent(imageId)}/edit`, apiKey, {
    method: 'POST',
    body: JSON.stringify({
      brandSessionId,
      prompt,
    }),
  });
  const accepted = parseEditAcceptedEnvelope(body);
  return [accepted.id];
}

export interface ListImagesQuery {
  ids?: string[];
  workspaceId?: string;
  brandSessionId?: string;
  limit?: number;
  cursor?: string;
  source?: BloomImageSource;
  status?: BloomImageGenStatus;
  actionType?: BloomImageActionType;
  includeUrls?: boolean;
  wait?: boolean;
  timeout?: number;
}

/**
 * GET /images — cursor-based list. Pass `includeUrls: true` for signed download URLs on completed images.
 */
export async function listImages(apiKey: string, query: ListImagesQuery = {}): Promise<BloomImagesListData> {
  const qs = new URLSearchParams();
  if (query.ids?.length) {
    qs.set('ids', query.ids.map((id) => String(id).trim()).filter(Boolean).join(','));
  }
  if (query.workspaceId && String(query.workspaceId).trim() !== '') {
    qs.set('workspaceId', String(query.workspaceId).trim());
  }
  if (query.brandSessionId && String(query.brandSessionId).trim() !== '') {
    qs.set('brandSessionId', String(query.brandSessionId).trim());
  }
  const limit = query.limit != null ? Math.min(100, Math.max(1, Math.floor(query.limit))) : 50;
  qs.set('limit', String(limit));
  if (query.cursor && String(query.cursor).trim() !== '') {
    qs.set('cursor', String(query.cursor).trim());
  }
  if (query.source) qs.set('source', query.source);
  if (query.status) qs.set('status', query.status);
  if (query.actionType) qs.set('actionType', query.actionType);
  if (query.includeUrls === true) {
    qs.set('includeUrls', 'true');
  }
  if (query.wait === true) {
    qs.set('wait', 'true');
  }
  if (query.timeout != null) {
    qs.set('timeout', String(Math.min(295, Math.max(1, Math.floor(query.timeout)))));
  }

  const body = await bloomFetchOkJson(`/images?${qs.toString()}`, apiKey, { method: 'GET' });
  return parseImagesListEnvelope(body);
}

/**
 * Polls the Bloom API until all images are complete.
 */
export async function pollImages(
  apiKey: string,
  brandSessionId: string,
  imageIds: string[],
  onProgress: (percent: number) => void
): Promise<BloomImageRow[]> {
  if (imageIds.length === 0) {
    onProgress(100);
    return [];
  }

  const deadline = Date.now() + 120_000;
  const idSet = new Set(imageIds.map((id) => String(id).trim()).filter(Boolean));
  let lastImages: BloomImageRow[] = [];

  onProgress(0);

  while (Date.now() < deadline) {
    const remainingSec = Math.max(1, Math.min(60, Math.ceil((deadline - Date.now()) / 1000)));
    const qs = new URLSearchParams();
    qs.set('ids', imageIds.map((id) => String(id).trim()).filter(Boolean).join(','));
    qs.set('wait', 'true');
    qs.set('timeout', String(remainingSec));
    qs.set('includeUrls', 'true');
    const bs = String(brandSessionId || '').trim();
    if (bs) qs.set('brandSessionId', bs);

    const body = await bloomFetchOkJson(`/images?${qs.toString()}`, apiKey, { method: 'GET' });
    const list = parseImagesListEnvelope(body);
    lastImages = list.images;

    const byId = new Map(
      lastImages.map((im) => [String(im.id || '').trim(), im] as const).filter(([k]) => k !== '')
    );
    let terminal = 0;
    let failed = false;
    for (const id of imageIds) {
      const tid = String(id).trim();
      const im = byId.get(tid);
      if (!im) continue;
      const st = effectiveImageGenStatus(im);
      if (isTerminalGenStatus(st)) {
        terminal += 1;
        if (st === 'failed') failed = true;
      }
    }

    onProgress(Math.round((terminal / imageIds.length) * 100));

    if (failed) {
      throw new Error('Bloom API: one or more images failed during generation');
    }

    if (terminal === imageIds.length) {
      const ordered = imageIds
        .map((id) => byId.get(String(id).trim()))
        .filter((x): x is BloomImageRow => x !== undefined);
      onProgress(100);
      return ordered.length === imageIds.length
        ? ordered
        : lastImages.filter((im) => idSet.has(String(im.id || '').trim()));
    }
  }

  throw new Error('Bloom API: timed out after 120s waiting for images to complete');
}

/**
 * GET /credits — returns numeric balance; unlimited accounts return `Number.MAX_SAFE_INTEGER`.
 */
export async function getCredits(apiKey: string): Promise<number> {
  const body = await bloomFetchOkJson('/credits', apiKey, { method: 'GET' });
  const credits = parseCreditsEnvelope(body);
  if (credits.unlimited) {
    return Number.MAX_SAFE_INTEGER;
  }
  return credits.balance;
}
