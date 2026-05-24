// Bloom REST API client for the plugin iframe.
// Shapes match the Bloom OpenAPI 3.1.1 spec (keep in sync with bloom-api-schema.ts).

const BLOOM_BASE = 'https://www.trybloom.ai/api/v1';
const BLOOM_ORIGIN = 'https://www.trybloom.ai';

export interface Brand {
  id: string;
  name: string;
  url: string;
  status: string;
  brandSessionId: string | undefined;
  logoUrl?: string;
  logoError?: string;
  imageCount?: number;
  workspaceId?: string;
  workspaceName?: string;
  createdAt?: string;
  colors?: unknown[];
  fonts?: unknown[];
  aesthetic?: string;
  summary?: string;
}

export interface ImageRow {
  id: string;
  source?: string;
  status: string;
  imageUrl?: string;
}

export interface LibraryItem {
  id: string;
  imageUrl: string;
  aspectRatio: string;
  insertPrompt: string;
}

export interface LibraryPage {
  images: Record<string, unknown>[];
  nextCursor?: string;
  hasMore: boolean;
}

// Normalizes a Bloom image path or URL to an absolute https URL.
export function getImageUrl(raw: unknown): string {
  if (raw == null || typeof raw !== 'string') return '';
  const u = raw.trim();
  if (u === '') return '';
  if (u.startsWith('https://') || u.startsWith('http://')) return u;
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('/')) return BLOOM_ORIGIN + u;
  return u;
}

function extractErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const o = body as Record<string, unknown>;
  if (typeof o.message === 'string') return o.message;
  const err = o.error ?? o.detail;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
    return (err as Record<string, unknown>).message as string;
  }
  return undefined;
}

async function bloomFetch(path: string, apiKey: string, options: RequestInit = {}): Promise<unknown> {
  try {
    const url = BLOOM_BASE + (path.startsWith('/') ? path : '/' + path);
    const headers = new Headers((options.headers as HeadersInit) || undefined);
    headers.set('x-api-key', apiKey);
    if (options.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const res = await fetch(url, { ...options, headers });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }

    if (!res.ok) {
      const detail = extractErrorMessage(body) ?? (typeof body === 'string' ? body : res.statusText);
      throw new Error(`Bloom API ${res.status} ${res.statusText}${detail ? ': ' + detail : ''}`);
    }

    return body;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Bloom API')) throw err;
    const m = err instanceof Error ? err.message : String(err);
    throw new Error(`We couldn't reach Bloom. Check your network and try again. ${m}`);
  }
}

// Returns true when valid, false for 4xx auth errors, throws for network failures.
export function validateApiKey(apiKey: string): Promise<boolean> {
  return bloomFetch('/brands?limit=1', apiKey, { method: 'GET' })
    .then(() => true)
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("We couldn't reach Bloom")) throw new Error(msg);
      return false;
    });
}

function normalizeBrand(raw: Record<string, unknown>): Brand {
  const id = String(raw.id ?? '');
  return {
    id,
    name: String(raw.name ?? ''),
    url: String(raw.url ?? ''),
    status: raw.status as string,
    brandSessionId: id || undefined,
    logoUrl: raw.logoUrl != null ? String(raw.logoUrl) : undefined,
    logoError: raw.logoError != null ? String(raw.logoError) : undefined,
    imageCount:
      typeof raw.imageCount === 'number' && isFinite(raw.imageCount) ? raw.imageCount : undefined,
    workspaceId: raw.workspaceId != null ? String(raw.workspaceId) : undefined,
    workspaceName: raw.workspaceName != null ? String(raw.workspaceName) : undefined,
    createdAt: raw.createdAt != null ? String(raw.createdAt) : undefined,
    colors: Array.isArray(raw.colors) ? raw.colors : undefined,
    fonts: Array.isArray(raw.fonts) ? raw.fonts : undefined,
    aesthetic: raw.aesthetic != null ? String(raw.aesthetic) : undefined,
    summary: raw.summary != null ? String(raw.summary) : undefined,
  };
}

// GET /brands — fetches all pages via cursor pagination.
export function listBrands(apiKey: string): Promise<Brand[]> {
  const out: Brand[] = [];
  let cursor: string | undefined;

  function fetchPage(): Promise<Brand[]> {
    const qs = new URLSearchParams();
    qs.set('limit', '100');
    if (cursor) qs.set('cursor', cursor);

    return bloomFetch('/brands?' + qs.toString(), apiKey, { method: 'GET' }).then((raw) => {
      const page = (raw as { data: { brands: Record<string, unknown>[]; nextCursor?: string; hasMore: boolean } }).data;
      for (const b of page.brands) out.push(normalizeBrand(b));
      const next =
        typeof page.nextCursor === 'string' && page.nextCursor.length > 0 ? page.nextCursor : undefined;
      if (!page.hasMore || !next || page.brands.length === 0) return out;
      cursor = next;
      return fetchPage();
    });
  }

  return fetchPage();
}

// POST /brands — returns a provisional brand with status 'analyzing'.
export function onboardBrand(apiKey: string, url: string): Promise<Brand> {
  return bloomFetch('/brands', apiKey, {
    method: 'POST',
    body: JSON.stringify({ url }),
  }).then((raw) => {
    const d = (raw as { data: { id: string; status: string; logoError?: string } }).data;
    const brand: Brand = {
      id: d.id,
      name: '',
      url,
      status: d.status,
      brandSessionId: d.id || undefined,
    };
    if (d.logoError != null) brand.logoError = String(d.logoError);
    return brand;
  });
}

export function getBrand(apiKey: string, brandId: string): Promise<Brand> {
  return bloomFetch('/brands/' + encodeURIComponent(brandId), apiKey, { method: 'GET' }).then((raw) =>
    normalizeBrand((raw as { data: Record<string, unknown> }).data),
  );
}

// POST /images/generations — returns new image ids for polling.
export function generateImages(
  apiKey: string,
  brandSessionId: string,
  prompt: string,
  aspectRatio: string,
  variantCount: number,
): Promise<string[]> {
  const clamped = Math.min(5, Math.max(1, Math.floor(variantCount)));
  return bloomFetch('/images/generations', apiKey, {
    method: 'POST',
    body: JSON.stringify({ prompt, brandSessionId, aspectRatio, variantCount: clamped }),
  }).then((raw) => (raw as { data: { ids: string[] } }).data.ids);
}

// POST /images/{id}/edit — returns a singleton id array for polling parity with generateImages.
export function editImage(
  apiKey: string,
  brandSessionId: string,
  imageId: string,
  instruction: string,
): Promise<string[]> {
  return bloomFetch('/images/' + encodeURIComponent(imageId) + '/edit', apiKey, {
    method: 'POST',
    body: JSON.stringify({ brandSessionId, prompt: instruction }),
  }).then((raw) => [(raw as { data: { id: string } }).data.id]);
}

function mapImagesForPolling(body: unknown): ImageRow[] {
  const b = body as { data: { images: Record<string, unknown>[] } };
  return b.data.images.map((row) => ({
    id: String(row.id),
    source: row.source as string | undefined,
    status: row.status == null ? 'pending' : String(row.status),
    imageUrl:
      row.imageUrl != null && row.imageUrl !== ''
        ? getImageUrl(String(row.imageUrl))
        : undefined,
  }));
}

function isTerminalStatus(s: string): boolean {
  return s === 'completed' || s === 'failed';
}

// Polls GET /images until all ids reach a terminal status.
// Calls onProgress with 0–100 as images complete. Rejects after 120 s or on failure.
export function pollImages(
  apiKey: string,
  brandSessionId: string,
  imageIds: string[],
  onProgress: (pct: number) => void,
): Promise<ImageRow[]> {
  if (imageIds.length === 0) {
    onProgress(100);
    return Promise.resolve([]);
  }

  const deadline = Date.now() + 120_000;
  const idSet: Record<string, boolean> = {};
  for (const id of imageIds) idSet[String(id).trim()] = true;
  let lastImages: ImageRow[] = [];
  onProgress(0);

  function pollOnce(): Promise<ImageRow[]> {
    if (Date.now() >= deadline) {
      return Promise.reject(new Error('Bloom API: timed out after 120s waiting for images to complete'));
    }
    const remainingSec = Math.max(1, Math.min(60, Math.ceil((deadline - Date.now()) / 1000)));
    const qs = new URLSearchParams();
    qs.set('ids', imageIds.map((id) => String(id).trim()).filter(Boolean).join(','));
    qs.set('wait', 'true');
    qs.set('timeout', String(remainingSec));
    qs.set('includeUrls', 'true');
    if (brandSessionId && brandSessionId.trim() !== '') qs.set('brandSessionId', brandSessionId.trim());

    return bloomFetch('/images?' + qs.toString(), apiKey, { method: 'GET' }).then((raw) => {
      lastImages = mapImagesForPolling(raw);
      const byId: Record<string, ImageRow> = {};
      for (const row of lastImages) {
        const kid = String(row.id ?? '').trim();
        if (kid) byId[kid] = row;
      }

      let terminal = 0;
      let failed = false;
      for (const id of imageIds) {
        const im = byId[String(id ?? '').trim()];
        if (im && isTerminalStatus(im.status)) {
          terminal += 1;
          if (im.status === 'failed') failed = true;
        }
      }

      onProgress(Math.round((terminal / imageIds.length) * 100));

      if (failed) throw new Error('Bloom API: one or more images failed during generation');

      if (terminal === imageIds.length) {
        const ordered = imageIds
          .map((id) => byId[String(id ?? '').trim()])
          .filter((x): x is ImageRow => x !== undefined);
        onProgress(100);
        return ordered.length === imageIds.length
          ? ordered
          : lastImages.filter((im) => idSet[String(im.id ?? '').trim()]);
      }

      return pollOnce();
    });
  }

  return pollOnce();
}

// GET /images — one page of completed generated images for the Library view.
export function listBrandCompletedImagesPage(
  apiKey: string,
  brandSessionId: string,
  cursorForRequest: string | null,
): Promise<LibraryPage> {
  const qs = new URLSearchParams();
  qs.set('limit', '50');
  qs.set('source', 'generated');
  qs.set('status', 'completed');
  qs.set('includeUrls', 'true');
  if (brandSessionId && brandSessionId.trim() !== '') qs.set('brandSessionId', brandSessionId.trim());
  if (cursorForRequest && cursorForRequest.trim() !== '') qs.set('cursor', cursorForRequest.trim());

  return bloomFetch('/images?' + qs.toString(), apiKey, { method: 'GET' }).then(
    (raw) => (raw as { data: LibraryPage }).data,
  );
}

export function mapListRowToLibraryItem(row: Record<string, unknown>): LibraryItem {
  const imageUrl =
    row.imageUrl != null && row.imageUrl !== '' ? getImageUrl(String(row.imageUrl)) : '';
  const aspectRatio = row.aspectRatio && typeof row.aspectRatio === 'string' ? row.aspectRatio : '1:1';
  const promptText = row.prompt && String(row.prompt).trim() ? String(row.prompt).trim() : '';
  const desc = row.description && String(row.description).trim() ? String(row.description).trim() : '';
  return {
    id: String(row.id),
    imageUrl,
    aspectRatio,
    insertPrompt: promptText || desc || 'Library image',
  };
}

// GET /credits — returns numeric balance, or MAX_SAFE_INTEGER when unlimited.
export function getCredits(apiKey: string): Promise<number> {
  return bloomFetch('/credits', apiKey, { method: 'GET' }).then((raw) => {
    const credits = (raw as { data: { unlimited?: boolean; balance: number } }).data;
    return credits.unlimited ? Number.MAX_SAFE_INTEGER : credits.balance;
  });
}
