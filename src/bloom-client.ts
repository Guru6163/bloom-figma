/**
 * bloom-client.ts
 *
 * Bloom REST API client for use inside the Figma plugin UI.
 * All functions use fetch() which is available in the ui.html iframe.
 *
 * API docs: https://www.trybloom.ai/api/v1/docs
 */

const BLOOM_BASE = 'https://www.trybloom.ai/api/v1';

// --- Types ---

export interface BloomBrand {
  id: string;
  name: string;
  url: string;
  status: 'analyzing' | 'ready' | 'logo_required' | 'failed';
  brandSessionId?: string;
}

export interface BloomImage {
  id: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  imageUrl?: string;
}

// --- Base fetcher ---

function unwrapData<T>(body: unknown): T {
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data;
  }
  return body as T;
}

function extractErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const o = body as Record<string, unknown>;
  const err = o.error ?? o.message ?? o.detail;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return undefined;
}

/**
 * Makes an authenticated request to the Bloom API.
 * Throws a descriptive error if the response is not ok.
 */
export async function bloomFetch<T>(
  path: string,
  apiKey: string,
  options: RequestInit = {}
): Promise<T> {
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
      const detail = extractErrorMessage(body) ?? (typeof body === 'string' ? body : res.statusText);
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

// --- Brand functions ---

function normalizeBrand(raw: Record<string, unknown>): BloomBrand {
  const id = String(raw.id ?? '');
  const name = String(raw.name ?? '');
  const url = String(raw.url ?? raw.brand_url ?? raw.brandUrl ?? '');
  const status = raw.status as BloomBrand['status'];
  const brandSessionId =
    raw.brandSessionId !== undefined
      ? String(raw.brandSessionId)
      : raw.brand_session_id !== undefined
        ? String(raw.brand_session_id)
        : undefined;
  return {
    id,
    name,
    url,
    status,
    brandSessionId: brandSessionId || undefined,
  };
}

function extractBrandsPayload(body: unknown): { brands: unknown[]; nextCursor?: string | null } {
  if (!body || typeof body !== 'object') {
    return { brands: [] };
  }
  const root = body as Record<string, unknown>;

  if (Array.isArray(root.brands)) {
    return {
      brands: root.brands,
      nextCursor: (root.next_cursor ?? root.nextCursor) as string | null | undefined,
    };
  }

  const data = root.data;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.brands)) {
      return {
        brands: d.brands,
        nextCursor: (d.next_cursor ?? d.nextCursor) as string | null | undefined,
      };
    }
  }

  return { brands: [] };
}

/**
 * Validates an API key by attempting to list brands.
 * Returns true if the key is valid, false otherwise.
 */
export async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    await bloomFetch<unknown>('/brands?limit=1', apiKey, { method: 'GET' });
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
 * Returns all brands for this API key.
 * Handles multiple possible response shapes from the API.
 */
export async function listBrands(apiKey: string): Promise<BloomBrand[]> {
  const out: BloomBrand[] = [];
  let cursor: string | undefined;

  for (;;) {
    const qs = new URLSearchParams();
    qs.set('limit', '100');
    if (cursor) qs.set('cursor', cursor);

    const raw = await bloomFetch<unknown>(`/brands?${qs.toString()}`, apiKey, { method: 'GET' });
    const { brands, nextCursor } = extractBrandsPayload(raw);

    for (const item of brands) {
      if (item && typeof item === 'object') {
        out.push(normalizeBrand(item as Record<string, unknown>));
      }
    }

    const next = nextCursor ?? undefined;
    if (!next || brands.length === 0) break;
    cursor = next;
  }

  return out;
}

/**
 * Starts onboarding a new brand from a website URL.
 * Returns immediately — brand will be in 'analyzing' status.
 * Poll getBrand() until status is 'ready'.
 */
export async function onboardBrand(apiKey: string, url: string): Promise<BloomBrand> {
  const raw = await bloomFetch<unknown>(
    '/brands',
    apiKey,
    {
      method: 'POST',
      body: JSON.stringify({ url }),
    }
  );

  const data = unwrapData<Record<string, unknown>>(raw);
  const id = String(data.id ?? '');
  const status = data.status as BloomBrand['status'];
  return {
    id,
    name: '',
    url,
    status,
    brandSessionId: id,
  };
}

/**
 * Gets a single brand by ID.
 * Use this to poll for onboarding completion.
 */
export async function getBrand(apiKey: string, brandId: string): Promise<BloomBrand> {
  const raw = await bloomFetch<unknown>(`/brands/${encodeURIComponent(brandId)}`, apiKey, { method: 'GET' });
  const data = unwrapData<Record<string, unknown>>(raw);
  return normalizeBrand(data);
}

// --- Image functions ---

/**
 * Image IDs from POST /images/generations ({ data: { ids } })
 * or POST /images/{id}/edit ({ data: { id } }).
 */
function parseGenerationImageIds(body: unknown): string[] {
  const data = unwrapData<unknown>(body);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return [];
  }
  const o = data as Record<string, unknown>;
  const rawIds = o.ids;
  if (Array.isArray(rawIds) && rawIds.length > 0) {
    return rawIds
      .map((x) => (typeof x === 'string' ? x : x != null ? String(x) : ''))
      .filter((x) => x !== '');
  }
  if (o.id != null && String(o.id) !== '') {
    return [String(o.id)];
  }
  return [];
}

/**
 * Starts generating images using the Bloom API.
 * Returns image IDs immediately — images generate asynchronously.
 * Poll `pollImages(apiKey, brandSessionId, ids, …)` until all images are complete.
 *
 * @param brandSessionId - Use brand.brandSessionId or brand.id
 * @param aspectRatio - One of: "1:1" | "4:5" | "9:16" | "16:9"
 * @param variantCount - Number of variants to generate (1-5)
 */
export async function generateImages(
  apiKey: string,
  brandSessionId: string,
  prompt: string,
  aspectRatio: string,
  variantCount: number
): Promise<string[]> {
  const clamped = Math.min(5, Math.max(1, Math.floor(variantCount)));
  const raw = await bloomFetch<unknown>(
    '/images/generations',
    apiKey,
    {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        brandSessionId,
        brand_session_id: brandSessionId,
        aspectRatio,
        aspect_ratio: aspectRatio,
        variantCount: clamped,
        variant_count: clamped,
      }),
    }
  );
  const ids = parseGenerationImageIds(raw);
  if (ids.length === 0) {
    throw new Error('Bloom API: image generation returned no image IDs');
  }
  return ids;
}

/**
 * Applies an edit prompt to an existing image (POST /images/{id}/edit).
 */
export async function editImage(
  apiKey: string,
  brandSessionId: string,
  imageId: string,
  prompt: string
): Promise<string[]> {
  const raw = await bloomFetch<unknown>(
    `/images/${encodeURIComponent(imageId)}/edit`,
    apiKey,
    {
      method: 'POST',
      body: JSON.stringify({
        brandSessionId,
        brand_session_id: brandSessionId,
        prompt,
      }),
    }
  );
  const ids = parseGenerationImageIds(raw);
  if (ids.length > 0) return ids;
  throw new Error('Bloom API: edit returned no image IDs');
}

function parseImagesList(body: unknown): BloomImage[] {
  const root = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  let images: unknown[] = [];

  const dataObj = unwrapData<Record<string, unknown>>(body);
  if (dataObj && typeof dataObj === 'object' && Array.isArray(dataObj.images)) {
    images = dataObj.images as unknown[];
  } else if (Array.isArray(root.images)) {
    images = root.images;
  } else if (root.data && typeof root.data === 'object' && Array.isArray((root.data as Record<string, unknown>).images)) {
    images = (root.data as Record<string, unknown>).images as unknown[];
  }

  return images.map((item) => {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const id = String(o.id ?? '');
    const status = (o.status ?? 'pending') as BloomImage['status'];
    const imageUrl =
      (o.imageUrl ?? o.image_url) !== undefined ? String(o.imageUrl ?? o.image_url) : undefined;
    return { id, status, imageUrl };
  });
}

function isTerminalStatus(s: BloomImage['status'] | undefined): boolean {
  return s === 'completed' || s === 'failed';
}

/**
 * Polls the Bloom API until all images are complete.
 * GET /images uses comma-separated `ids`, `includeUrls=true` for usable URLs, optional `brandSessionId`.
 */
export async function pollImages(
  apiKey: string,
  brandSessionId: string,
  imageIds: string[],
  onProgress: (percent: number) => void
): Promise<BloomImage[]> {
  if (imageIds.length === 0) {
    onProgress(100);
    return [];
  }

  const deadline = Date.now() + 120_000;
  const idSet = new Set(imageIds.map((id) => String(id).trim()).filter(Boolean));
  let lastImages: BloomImage[] = [];

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

    const raw = await bloomFetch<unknown>(`/images?${qs.toString()}`, apiKey, { method: 'GET' });
    lastImages = parseImagesList(raw);

    const byId = new Map(
      lastImages.map((im) => [String(im.id || '').trim(), im] as const).filter(([k]) => k !== '')
    );
    let terminal = 0;
    let failed = false;
    for (const id of imageIds) {
      const tid = String(id).trim();
      const im = byId.get(tid);
      if (im && isTerminalStatus(im.status)) {
        terminal += 1;
        if (im.status === 'failed') failed = true;
      }
    }

    onProgress(Math.round((terminal / imageIds.length) * 100));

    if (failed) {
      throw new Error('Bloom API: one or more images failed during generation');
    }

    if (terminal === imageIds.length) {
      const ordered = imageIds
        .map((id) => byId.get(String(id).trim()))
        .filter((x): x is BloomImage => x !== undefined);
      onProgress(100);
      return ordered.length === imageIds.length ? ordered : lastImages.filter((im) => idSet.has(String(im.id || '').trim()));
    }
  }

  throw new Error('Bloom API: timed out after 120s waiting for images to complete');
}

/**
 * Gets the credit balance for this API key.
 */
export async function getCredits(apiKey: string): Promise<number> {
  const raw = await bloomFetch<unknown>('/credits', apiKey, { method: 'GET' });
  const data = unwrapData<Record<string, unknown>>(raw);
  const balance = data.balance ?? data.creditBalance ?? data.credit_balance;
  if (typeof balance === 'number' && Number.isFinite(balance)) {
    return balance;
  }
  if (typeof balance === 'string' && balance.trim() !== '' && Number.isFinite(Number(balance))) {
    return Number(balance);
  }
  const unlimited = data.unlimited === true;
  if (unlimited) {
    return Number.MAX_SAFE_INTEGER;
  }
  throw new Error('Bloom API: credits response did not include a numeric balance');
}
