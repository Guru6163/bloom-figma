/**
 * @file Bloom REST API client for the typed reference implementation (not bundled into
 * the default UI build; keep in sync with the inlined client in `ui.html`).
 * https://www.trybloom.ai/api/v1/spec.json
 */

import {
  extractBloomErrorMessage,
  toBloomBrand,
  effectiveImageGenStatus,
  type BloomBrand,
  type BloomImageRow,
  type BloomImagesListData,
  type BloomImageGenStatus,
  type BloomImageSource,
  type BloomImageActionType,
  type BloomAspectRatio,
  type BloomSuccessEnvelope,
  type BloomBrandsListData,
  type BloomBrandDetailData,
  type BloomOnboardBrandData,
  type BloomGenerationAcceptedData,
  type BloomImageMutationAcceptedData,
  type BloomCreditsData,
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
  BloomAccountData,
  BloomCreditsData,
  BloomWorkspacesListData,
  BloomImageSearchData,
  BloomImageUploadData,
} from './bloom-api-schema';

export { effectiveImageGenStatus, extractBloomErrorMessage } from './bloom-api-schema';

const BLOOM_BASE = 'https://www.trybloom.ai/api/v1';

/**
 * Parses JSON for a successful (2xx) Bloom HTTP response into the expected type.
 */
async function bloomFetch<T>(path: string, apiKey: string, options: RequestInit = {}): Promise<T> {
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

    return body as T;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Bloom API')) {
      throw e;
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`We couldn't reach Bloom. Check your network and try again. ${msg}`);
  }
}

/**
 * Returns true when polling can stop for this image (`completed` or `failed`).
 */
function isTerminalGenStatus(s: ReturnType<typeof effectiveImageGenStatus>): boolean {
  return s === 'completed' || s === 'failed';
}

/**
 * Validates an API key by attempting to list brands.
 * @param apiKey - Bloom API key sent as `x-api-key`.
 * @returns `true` when GET /brands succeeds with the key.
 * @throws When the request fails for network/DNS reasons (message starts with "We couldn't reach Bloom").
 * Returns `false` for invalid or unauthorized keys (HTTP 4xx), not for network failures.
 */
export async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    await bloomFetch<BloomSuccessEnvelope<BloomBrandsListData>>('/brands?limit=1', apiKey, { method: 'GET' });
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
 * @param apiKey - Bloom API key sent as `x-api-key`.
 * @returns Every brand across all pages, normalized via `toBloomBrand`.
 * @throws On network failure or any non-2xx HTTP response from the Bloom API.
 */
export async function listBrands(apiKey: string): Promise<BloomBrand[]> {
  const out: BloomBrand[] = [];
  let cursor: string | undefined;

  for (;;) {
    const qs = new URLSearchParams();
    qs.set('limit', '100');
    if (cursor) qs.set('cursor', cursor);

    const { data: page } = await bloomFetch<BloomSuccessEnvelope<BloomBrandsListData>>(
      `/brands?${qs.toString()}`,
      apiKey,
      { method: 'GET' }
    );
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
 * Starts brand onboarding from a website URL (POST /brands).
 * @param apiKey - Bloom API key sent as `x-api-key`.
 * @param url - Public website URL for Bloom to analyze.
 * @returns A provisional `BloomBrand` with status `analyzing` or `logo_required`; poll with `getBrand`.
 * @throws On network failure or non-2xx HTTP response.
 */
export async function onboardBrand(apiKey: string, url: string): Promise<BloomBrand> {
  const { data: d } = await bloomFetch<BloomSuccessEnvelope<BloomOnboardBrandData>>('/brands', apiKey, {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
  return toBloomBrand({
    id: d.id,
    name: '',
    url,
    status: d.status,
    imageCount: 0,
    workspaceId: null,
    workspaceName: '',
    createdAt: new Date().toISOString(),
    logoError: d.logoError,
  });
}

/**
 * Fetches a single brand by id (GET /brands/{id}).
 * @param apiKey - Bloom API key sent as `x-api-key`.
 * @param brandId - Brand id / brand session id.
 * @returns Full brand detail with `brandSessionId` alias.
 * @throws On network failure or non-2xx HTTP response (e.g. unknown id).
 */
export async function getBrand(apiKey: string, brandId: string): Promise<BloomBrand> {
  const { data: detail } = await bloomFetch<BloomSuccessEnvelope<BloomBrandDetailData>>(
    `/brands/${encodeURIComponent(brandId)}`,
    apiKey,
    { method: 'GET' }
  );
  return toBloomBrand(detail);
}

/**
 * Starts on-brand image generation (POST /images/generations).
 * @param apiKey - Bloom API key sent as `x-api-key`.
 * @param brandSessionId - Active brand session id.
 * @param prompt - Generation prompt text.
 * @param aspectRatio - Bloom aspect ratio token (e.g. `"16:9"`).
 * @param variantCount - Desired variants; clamped to 1–5 inclusive.
 * @returns Image ids to pass to `pollImages`.
 * @throws On network failure or non-2xx HTTP response.
 */
export async function generateImages(
  apiKey: string,
  brandSessionId: string,
  prompt: string,
  aspectRatio: BloomAspectRatio,
  variantCount: number
): Promise<string[]> {
  const clamped = Math.min(5, Math.max(1, Math.floor(variantCount)));
  const { data: accepted } = await bloomFetch<BloomSuccessEnvelope<BloomGenerationAcceptedData>>(
    '/images/generations',
    apiKey,
    {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        brandSessionId,
        aspectRatio,
        variantCount: clamped,
      }),
    }
  );
  return accepted.ids;
}

/**
 * Starts an image edit from a text instruction (POST /images/{id}/edit).
 * @param apiKey - Bloom API key sent as `x-api-key`.
 * @param brandSessionId - Active brand session id.
 * @param imageId - Source image id to edit.
 * @param prompt - Edit instruction text.
 * @returns Singleton array with the new pending image id (for `pollImages` parity with generate).
 * @throws On network failure or non-2xx HTTP response.
 */
export async function editImage(
  apiKey: string,
  brandSessionId: string,
  imageId: string,
  prompt: string
): Promise<string[]> {
  const { data: accepted } = await bloomFetch<BloomSuccessEnvelope<BloomImageMutationAcceptedData>>(
    `/images/${encodeURIComponent(imageId)}/edit`,
    apiKey,
    {
      method: 'POST',
      body: JSON.stringify({
        brandSessionId,
        prompt,
      }),
    }
  );
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
 * Lists images with optional filters (GET /images).
 * @param apiKey - Bloom API key sent as `x-api-key`.
 * @param query - Optional ids, brandSessionId, cursor, `includeUrls`, `wait`, etc.
 * @returns One page of `data` (`images`, `nextCursor`, `hasMore`).
 * @throws On network failure or non-2xx HTTP response.
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

  const { data } = await bloomFetch<BloomSuccessEnvelope<BloomImagesListData>>(
    `/images?${qs.toString()}`,
    apiKey,
    { method: 'GET' }
  );
  return data;
}

/**
 * Polls the Bloom API until all requested images reach a terminal status.
 * @param apiKey - Bloom API key sent as `x-api-key`.
 * @param brandSessionId - Brand session id (sent as query param when non-empty).
 * @param imageIds - Ids returned from `generateImages` or `editImage`.
 * @param onProgress - Called with 0–100 as images reach `completed` or `failed`.
 * @returns Completed image rows with URLs when `includeUrls` was requested.
 * @throws If any image status is `failed`, or after 120s without all ids terminal.
 * Calls `onProgress(100)` immediately when `imageIds` is empty.
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

    const { data: list } = await bloomFetch<BloomSuccessEnvelope<BloomImagesListData>>(
      `/images?${qs.toString()}`,
      apiKey,
      { method: 'GET' }
    );
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
 * Fetches the account credit balance (GET /credits).
 * @param apiKey - Bloom API key sent as `x-api-key`.
 * @returns Numeric balance, or `Number.MAX_SAFE_INTEGER` when `data.unlimited` is true.
 * @throws On network failure or non-2xx HTTP response.
 */
export async function getCredits(apiKey: string): Promise<number> {
  const { data: credits } = await bloomFetch<BloomSuccessEnvelope<BloomCreditsData>>('/credits', apiKey, {
    method: 'GET',
  });
  if (credits.unlimited) {
    return Number.MAX_SAFE_INTEGER;
  }
  return credits.balance;
}
