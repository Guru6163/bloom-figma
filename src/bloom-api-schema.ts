/**
 * @file Bloom HTTP API (OpenAPI 3.1.1) — typed request/response shapes.
 * https://www.trybloom.ai/api/v1/spec.json
 */

// --- Envelope ---

export interface BloomSuccessEnvelope<T> {
  data: T;
}

// --- Error bodies (4xx/5xx) ---

export interface BloomApiErrorBody {
  defined: boolean;
  code: string;
  status: number;
  message: string;
  data?: unknown;
}

/**
 * Best-effort extraction of a human-readable message from a Bloom error JSON body.
 * @param body - Parsed JSON from a non-2xx response, or `null` when the body was empty.
 * @returns The first usable message string, or `undefined` if none was found.
 */
export function extractBloomErrorMessage(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const o = body as Record<string, unknown>;
  if (typeof o.message === 'string') return o.message;
  const err = o.error ?? o.detail;
  if (typeof err === 'string') return err;
  if (err !== null && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return undefined;
}

// --- Account ---

/** GET /account — data */
export interface BloomAccountData {
  email: string;
  name: string | null;
}

/** GET /credits — data */
export interface BloomCreditsData {
  balance: number;
  unlimited: boolean;
}

/** GET /workspaces — each workspace row */
export interface BloomWorkspaceItem {
  id: string | null;
  name: string;
}

/** GET /workspaces — data */
export interface BloomWorkspacesListData {
  workspaces: BloomWorkspaceItem[];
}

// --- Brands ---

export const BLOOM_BRAND_STATUSES = ['analyzing', 'ready', 'logo_required', 'failed'] as const;
export type BloomBrandStatus = (typeof BLOOM_BRAND_STATUSES)[number];

export const BLOOM_ONBOARD_STATUSES = ['analyzing', 'logo_required'] as const;
export type BloomOnboardStatus = (typeof BLOOM_ONBOARD_STATUSES)[number];

export const BLOOM_LOGO_UPDATE_STATUSES = ['analyzing', 'ready'] as const;
export type BloomLogoUpdateStatus = (typeof BLOOM_LOGO_UPDATE_STATUSES)[number];

/** GET /brands — each item in data.brands */
export interface BloomBrandListItem {
  id: string;
  name: string;
  url: string;
  status: BloomBrandStatus;
  imageCount: number;
  workspaceId: string | null;
  workspaceName: string;
  createdAt: string;
}

/** GET /brands/{id} — data */
export interface BloomBrandDetailData {
  id: string;
  status: BloomBrandStatus;
  name: string;
  url: string;
  logoUrl: string | null;
  logoError?: string;
  colors: string[];
  fonts: string[];
  aesthetic: string | null;
  summary: string | null;
  workspaceId: string | null;
  workspaceName: string;
  createdAt: string;
}

/** GET /brands — data */
export interface BloomBrandsListData {
  brands: BloomBrandListItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** POST /brands — data */
export interface BloomOnboardBrandData {
  id: string;
  status: BloomOnboardStatus;
  logoError?: string;
}

/** PUT /brands/{id}/logo — data */
export interface BloomLogoUpdateData {
  id: string;
  status: BloomLogoUpdateStatus;
}

/** Plugin-facing brand with brandSessionId alias. */
export interface BloomBrand extends BloomBrandDetailData {
  brandSessionId: string;
}

/**
 * Adds `brandSessionId` alias equal to brand `id` for plugin code paths.
 * @param row - Brand list item from GET /brands or full detail from GET /brands/{id}.
 * @returns A `BloomBrand` with `brandSessionId` set; list rows get empty logo/colors defaults.
 */
export function toBloomBrand(row: BloomBrandListItem | BloomBrandDetailData): BloomBrand {
  if ('logoUrl' in row) {
    return { ...row, brandSessionId: row.id };
  }
  return {
    id: row.id,
    status: row.status,
    name: row.name,
    url: row.url,
    logoUrl: null,
    colors: [],
    fonts: [],
    aesthetic: null,
    summary: null,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    createdAt: row.createdAt,
    brandSessionId: row.id,
  };
}

// --- Images ---

export const BLOOM_ASPECT_RATIOS = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
] as const;
export type BloomAspectRatio = (typeof BLOOM_ASPECT_RATIOS)[number];

export type BloomImageSource = 'generated' | 'uploaded' | 'scraped';
export type BloomImageActionType = 'generation' | 'edit' | 'resize' | 'variant' | 'recreate';
export type BloomImageGenStatus = 'pending' | 'generating' | 'completed' | 'failed';
export type BloomImageSize = '2K' | '4K';
export type BloomModelTier = 'fast' | 'standard' | 'pro';

/** GET /images — each element of data.images */
export interface BloomImageListItem {
  id: string;
  source: BloomImageSource;
  brandSessionId?: string;
  prompt: string | null;
  description: string | null;
  aspectRatio: BloomAspectRatio | null;
  width: number | null;
  height: number | null;
  actionType: BloomImageActionType | null;
  variantGroupId: string | null;
  status: BloomImageGenStatus | null;
  imageUrl?: string | null;
  workspaceId: string | null;
  workspaceName: string;
  createdAt: string;
}

/** GET /images/{id} — data */
export interface BloomImageGetData {
  id: string;
  source: BloomImageSource;
  status: BloomImageGenStatus | null;
  prompt: string | null;
  description: string | null;
  imageUrl: string | null;
  aspectRatio: BloomAspectRatio | null;
  width: number | null;
  height: number | null;
  actionType: BloomImageActionType | null;
  variantGroupId: string | null;
  workspaceId: string | null;
  workspaceName: string;
  createdAt: string;
}

/** Alias for poll results / UI rows. */
export type BloomImageRow = BloomImageListItem;

/** GET /images — data */
export interface BloomImagesListData {
  images: BloomImageListItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** POST /images/generations — data */
export interface BloomGenerationAcceptedData {
  ids: string[];
  variantGroupId: string | null;
  status: 'pending';
}

/** POST /images/{id}/edit | POST /images/{id}/resize — data */
export interface BloomImageMutationAcceptedData {
  id: string;
  status: 'pending';
}

/** POST /images/uploads — data */
export interface BloomImageUploadData {
  id: string;
  imageUrl: string;
  width: number;
  height: number;
  mimeType: string;
}

/** POST /images/search — each candidate */
export interface BloomImageSearchCandidate {
  id: string;
  url: string;
  description: string;
  width: number | null;
  height: number | null;
  aspectRatio: BloomAspectRatio | null;
  distance: number;
}

/** POST /images/search — data */
export interface BloomImageSearchData {
  query: string;
  candidates: BloomImageSearchCandidate[];
  nextCursor: string | null;
  hasMore: boolean;
}

// --- Request bodies ---

export interface BloomCreateBrandBody {
  url: string;
  workspaceId?: string;
  logoUrl?: string;
}

export interface BloomUpdateLogoBody {
  logoUrl: string;
}

export interface BloomGenerateImageBody {
  prompt: string;
  brandSessionId: string;
  aspectRatio?: BloomAspectRatio;
  imageSize?: BloomImageSize;
  model?: BloomModelTier;
  variantCount?: number;
  referenceImageIds?: string[];
}

export interface BloomEditImageBody {
  prompt: string;
  brandSessionId: string;
  imageSize?: BloomImageSize;
  model?: BloomModelTier;
  referenceImageIds?: string[];
}

export interface BloomResizeImageBody {
  targetAspectRatio: BloomAspectRatio;
  brandSessionId: string;
}

export interface BloomUploadImageBody {
  imageUrl: string;
  brandSessionId?: string;
}

export interface BloomSearchImagesBody {
  brandSessionId: string;
  query: string;
  limit?: number;
  cursor?: string;
  maxDistance?: number;
}

/**
 * Treats missing/null image status as pending for polling logic.
 * @param row - Image row from GET /images list or GET /images/{id}.
 * @returns `pending` when `status` is null/undefined; otherwise the API status unchanged.
 */
export function effectiveImageGenStatus(row: BloomImageListItem | BloomImageGetData): BloomImageGenStatus {
  const s = row.status;
  if (s === null || s === undefined) return 'pending';
  return s;
}
