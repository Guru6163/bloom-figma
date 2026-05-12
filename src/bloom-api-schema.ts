/**
 * @file Bloom HTTP API (OpenAPI 3.1.1) — success envelopes and strict parsers.
 * https://www.trybloom.ai/api/v1/docs
 *
 * Image shapes:
 * - `GET /images` → `BloomImageListItem` (required keys per spec; optional `brandSessionId`, `imageUrl`)
 * - `GET /images/{id}` → `BloomImageGetData` (includes required `imageUrl`)
 *
 * All 2xx JSON bodies used by the Figma plugin are validated here so callers
 * never rely on `unknown` + blind casts.
 */

/**
 * Thrown when a Bloom 2xx JSON body does not match the expected envelope or field types.
 */
export class BloomApiParseError extends Error {
  /**
   * @param context Parser or endpoint label included in the error message.
   * @param message Human-readable validation failure.
   * @param received Optional raw value for debugging.
   */
  constructor(
    readonly context: string,
    message: string,
    readonly received?: unknown
  ) {
    super(`Bloom API (${context}): ${message}`);
    this.name = 'BloomApiParseError';
  }
}

/**
 * Narrows `unknown` to a plain object record (not null, not array).
 * @param v Wire JSON value.
 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// --- Envelope ---

export interface BloomSuccessEnvelope<T> {
  data: T;
}

/**
 * Requires a `{ data: object }` Bloom envelope and returns the inner `data` object.
 * @param body Parsed JSON root.
 * @param ctx Parser label for error messages.
 */
function requireEnvelope(body: unknown, ctx: string): Record<string, unknown> {
  if (!isRecord(body) || !('data' in body)) {
    throw new BloomApiParseError(ctx, 'response must be a JSON object with a data property', body);
  }
  const inner = (body as { data: unknown }).data;
  if (!isRecord(inner)) {
    throw new BloomApiParseError(ctx, 'data must be an object', inner);
  }
  return inner;
}

// --- Error bodies (4xx/5xx; shape varies by endpoint) ---

export interface BloomHttpErrorBody {
  message?: string;
  detail?: unknown;
  error?: string | { message?: string; code?: string };
}

/**
 * Best-effort extraction of a human-readable message from a Bloom error JSON body.
 * @param body Parsed error JSON or text.
 */
export function extractBloomErrorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const o = body as BloomHttpErrorBody;
  const err = o.error ?? o.message ?? o.detail;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return undefined;
}

// --- Brands ---

export const BLOOM_BRAND_STATUSES = ['analyzing', 'ready', 'logo_required', 'failed'] as const;
export type BloomBrandStatus = (typeof BLOOM_BRAND_STATUSES)[number];

/**
 * Asserts that `v` is one of the known brand lifecycle status strings.
 * @param v Raw status field.
 * @param ctx Parser label for errors.
 */
function assertBrandStatus(v: unknown, ctx: string): asserts v is BloomBrandStatus {
  if (typeof v !== 'string' || !(BLOOM_BRAND_STATUSES as readonly string[]).includes(v)) {
    throw new BloomApiParseError(ctx, `invalid brand status: ${String(v)}`, v);
  }
}

/** GET /brands — each item in data.brands */
export interface BloomBrandListItem {
  id: string;
  name: string;
  url: string;
  status: BloomBrandStatus;
  imageCount?: number;
  workspaceId?: string;
  workspaceName?: string;
  createdAt?: string;
  /** Present on POST /brands response when logo extraction fails. */
  logoError?: string | null;
}

/** GET /brands/{id} — data object */
export interface BloomBrandDetailData extends BloomBrandListItem {
  logoUrl?: string | null;
  logoError?: string | null;
  colors?: string[];
  fonts?: string[];
  aesthetic?: string | null;
  summary?: string;
}

/** GET /brands — data */
export interface BloomBrandsListData {
  brands: BloomBrandListItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Parses one element of `data.brands` from GET /brands.
 * @param raw Brand list item JSON.
 * @param ctx Parser label.
 * @param index Array index for error messages.
 */
function parseBrandListItem(raw: unknown, ctx: string, index: number): BloomBrandListItem {
  if (!isRecord(raw)) {
    throw new BloomApiParseError(ctx, `brands[${index}] must be an object`, raw);
  }
  const id = raw.id;
  const name = raw.name;
  const url = raw.url;
  const status = raw.status;
  if (typeof id !== 'string' || id.length === 0) {
    throw new BloomApiParseError(ctx, `brands[${index}].id must be a non-empty string`, id);
  }
  if (typeof name !== 'string') {
    throw new BloomApiParseError(ctx, `brands[${index}].name must be a string`, name);
  }
  if (typeof url !== 'string') {
    throw new BloomApiParseError(ctx, `brands[${index}].url must be a string`, url);
  }
  assertBrandStatus(status, `${ctx} brands[${index}].status`);
  const imageCount = raw.imageCount;
  const out: BloomBrandListItem = { id, name, url, status };
  if (typeof imageCount === 'number' && Number.isFinite(imageCount)) {
    out.imageCount = imageCount;
  }
  if (typeof raw.workspaceId === 'string') out.workspaceId = raw.workspaceId;
  if (typeof raw.workspaceName === 'string') out.workspaceName = raw.workspaceName;
  if (typeof raw.createdAt === 'string') out.createdAt = raw.createdAt;
  return out;
}

/** GET /brands?… */
export function parseBrandsListEnvelope(body: unknown, ctx = 'GET /brands'): BloomBrandsListData {
  const d = requireEnvelope(body, ctx);
  if (!Array.isArray(d.brands)) {
    throw new BloomApiParseError(ctx, 'data.brands must be an array', d.brands);
  }
  if (typeof d.hasMore !== 'boolean') {
    throw new BloomApiParseError(ctx, 'data.hasMore must be a boolean', d.hasMore);
  }
  const nc = d.nextCursor;
  if (!(typeof nc === 'string' || nc === null)) {
    throw new BloomApiParseError(ctx, 'data.nextCursor must be string or null', nc);
  }
  const brands = d.brands.map((item, i) => parseBrandListItem(item, ctx, i));
  return { brands, nextCursor: nc, hasMore: d.hasMore };
}

/** GET /brands/{id} */
export function parseBrandDetailEnvelope(body: unknown, ctx = 'GET /brands/{id}'): BloomBrandDetailData {
  const d = requireEnvelope(body, ctx);
  const base = parseBrandListItem(d, ctx, 0);
  const out: BloomBrandDetailData = { ...base };
  if ('logoUrl' in d) {
    const v = d.logoUrl;
    if (v !== null && v !== undefined && typeof v !== 'string') {
      throw new BloomApiParseError(ctx, 'data.logoUrl must be string or null', v);
    }
    if (typeof v === 'string') out.logoUrl = v;
    else if (v === null) out.logoUrl = null;
  }
  if ('logoError' in d) {
    const v = d.logoError;
    if (v !== null && v !== undefined && typeof v !== 'string') {
      throw new BloomApiParseError(ctx, 'data.logoError must be string or null', v);
    }
    if (typeof v === 'string') out.logoError = v;
    else if (v === null) out.logoError = null;
  }
  if (Array.isArray(d.colors)) {
    out.colors = d.colors.filter((x): x is string => typeof x === 'string');
  }
  if (Array.isArray(d.fonts)) {
    out.fonts = d.fonts.filter((x): x is string => typeof x === 'string');
  }
  if (typeof d.aesthetic === 'string') out.aesthetic = d.aesthetic;
  else if (d.aesthetic === null) out.aesthetic = null;
  if (typeof d.summary === 'string') out.summary = d.summary;
  return out;
}

/** POST /brands — data */
export interface BloomOnboardBrandData {
  id: string;
  status: BloomBrandStatus;
  logoError?: string | null;
}

/** Validates POST /brands onboard response `data` (`id`, `status`, optional `logoError`). */
export function parseOnboardBrandEnvelope(body: unknown, ctx = 'POST /brands'): BloomOnboardBrandData {
  const d = requireEnvelope(body, ctx);
  const id = d.id;
  const status = d.status;
  if (typeof id !== 'string' || id.length === 0) {
    throw new BloomApiParseError(ctx, 'data.id must be a non-empty string', id);
  }
  assertBrandStatus(status, `${ctx} data.status`);
  const out: BloomOnboardBrandData = { id, status };
  if ('logoError' in d) {
    const le = d.logoError;
    if (le !== null && le !== undefined && typeof le !== 'string') {
      throw new BloomApiParseError(ctx, 'data.logoError must be string or null', le);
    }
    if (typeof le === 'string') out.logoError = le;
    else if (le === null) out.logoError = null;
  }
  return out;
}

// --- Images (OpenAPI: GET /images list, GET /images/{id}) ---

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

const IMAGE_SOURCES: readonly string[] = ['generated', 'uploaded', 'scraped'];
const IMAGE_ACTION_TYPES: readonly string[] = ['generation', 'edit', 'resize', 'variant', 'recreate'];
const GEN_STATUSES: readonly string[] = ['pending', 'generating', 'completed', 'failed'];
const ASPECT_RATIOS: readonly string[] = BLOOM_ASPECT_RATIOS as unknown as readonly string[];

/** Required keys on each element of `data.images` (GET /images). */
const LIST_IMAGE_REQUIRED_KEYS = [
  'id',
  'source',
  'prompt',
  'description',
  'aspectRatio',
  'width',
  'height',
  'actionType',
  'variantGroupId',
  'status',
  'workspaceId',
  'workspaceName',
  'createdAt',
] as const;

/** Required keys on `data` for GET /images/{id}. */
const GET_IMAGE_REQUIRED_KEYS = [
  'id',
  'source',
  'status',
  'prompt',
  'description',
  'imageUrl',
  'aspectRatio',
  'width',
  'height',
  'actionType',
  'variantGroupId',
  'workspaceId',
  'workspaceName',
  'createdAt',
] as const;

/**
 * Ensures a required key exists on an image row object before field-by-field parsing.
 * @param r Image object record.
 * @param key Required property name.
 * @param ctx Parser label.
 * @param index Image index in list, or null for GET-by-id `data`.
 */
function requireImageKey(
  r: Record<string, unknown>,
  key: string,
  ctx: string,
  index: number | null
): void {
  if (!(key in r)) {
    const loc = index === null ? 'data' : `images[${index}]`;
    throw new BloomApiParseError(ctx, `${loc} missing required property: ${key}`, r);
  }
}

/**
 * Parses a nullable string field on an image row.
 * @param v Raw field value.
 * @param field Field name for errors.
 * @param ctx Parser label.
 * @param index Image index or null for single-image `data`.
 */
function parseStringOrNull(v: unknown, field: string, ctx: string, index: number | null): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') {
    const loc = index === null ? `data.${field}` : `images[${index}].${field}`;
    throw new BloomApiParseError(ctx, `${loc} must be string or null`, v);
  }
  return v;
}

/**
 * Parses a nullable finite number field on an image row.
 * @param v Raw field value.
 * @param field Field name for errors.
 * @param ctx Parser label.
 * @param index Image index or null.
 */
function parseNumberOrNull(v: unknown, field: string, ctx: string, index: number | null): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    const loc = index === null ? `data.${field}` : `images[${index}].${field}`;
    throw new BloomApiParseError(ctx, `${loc} must be number or null`, v);
  }
  return v;
}

/**
 * Parses a nullable supported aspect ratio string.
 * @param v Raw aspect ratio field.
 * @param ctx Parser label.
 * @param index Image index or null.
 */
function parseAspectRatioOrNull(v: unknown, ctx: string, index: number | null): string | null {
  if (v === null) return null;
  if (typeof v !== 'string' || !ASPECT_RATIOS.includes(v)) {
    const loc = index === null ? 'data.aspectRatio' : `images[${index}].aspectRatio`;
    throw new BloomApiParseError(ctx, `${loc} must be a supported ratio or null`, v);
  }
  return v;
}

/**
 * Parses required image `source` enum.
 * @param v Raw source field.
 * @param ctx Parser label.
 * @param index Image index or null.
 */
function parseSourceRequired(v: unknown, ctx: string, index: number | null): BloomImageSource {
  if (typeof v !== 'string' || !IMAGE_SOURCES.includes(v)) {
    const loc = index === null ? 'data.source' : `images[${index}].source`;
    throw new BloomApiParseError(ctx, `${loc} must be generated | uploaded | scraped`, v);
  }
  return v as BloomImageSource;
}

/**
 * Parses nullable image action type enum.
 * @param v Raw actionType field.
 * @param ctx Parser label.
 * @param index Image index or null.
 */
function parseActionTypeOrNull(v: unknown, ctx: string, index: number | null): BloomImageActionType | null {
  if (v === null) return null;
  if (typeof v !== 'string' || !IMAGE_ACTION_TYPES.includes(v)) {
    const loc = index === null ? 'data.actionType' : `images[${index}].actionType`;
    throw new BloomApiParseError(ctx, `${loc} must be a known action type or null`, v);
  }
  return v as BloomImageActionType;
}

/**
 * Parses nullable generation status enum.
 * @param v Raw status field.
 * @param ctx Parser label.
 * @param index Image index or null.
 */
function parseGenStatusOrNull(v: unknown, ctx: string, index: number | null): BloomImageGenStatus | null {
  if (v === null) return null;
  if (typeof v !== 'string' || !GEN_STATUSES.includes(v)) {
    const loc = index === null ? 'data.status' : `images[${index}].status`;
    throw new BloomApiParseError(ctx, `${loc} must be a generation status or null`, v);
  }
  return v as BloomImageGenStatus;
}

/**
 * Parses nullable variant group id (uuid string or null).
 * @param v Raw variantGroupId field.
 * @param ctx Parser label.
 * @param index Image index or null.
 */
function parseVariantGroupIdOrNull(v: unknown, ctx: string, index: number | null): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') {
    const loc = index === null ? 'data.variantGroupId' : `images[${index}].variantGroupId`;
    throw new BloomApiParseError(ctx, `${loc} must be string or null`, v);
  }
  return v;
}

/**
 * GET /images — each element of `data.images` (OpenAPI required set).
 * Optional: `brandSessionId`, `imageUrl` (not in the spec’s required array for list).
 */
export interface BloomImageListItem {
  id: string;
  source: BloomImageSource;
  brandSessionId?: string;
  prompt: string | null;
  description: string | null;
  aspectRatio: string | null;
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

/** GET /images/{id} — `data` object (includes required `imageUrl`). */
export interface BloomImageGetData {
  id: string;
  source: BloomImageSource;
  status: BloomImageGenStatus | null;
  prompt: string | null;
  description: string | null;
  imageUrl: string | null;
  aspectRatio: string | null;
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

export interface BloomImagesListData {
  images: BloomImageListItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Parses one element of `data.images` from GET /images.
 * @param raw Image row JSON.
 * @param ctx Parser label.
 * @param index Row index for errors.
 */
function parseImageListItem(raw: unknown, ctx: string, index: number): BloomImageListItem {
  if (!isRecord(raw)) {
    throw new BloomApiParseError(ctx, `images[${index}] must be an object`, raw);
  }
  for (const k of LIST_IMAGE_REQUIRED_KEYS) {
    requireImageKey(raw, k, ctx, index);
  }
  const id = raw.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new BloomApiParseError(ctx, `images[${index}].id must be a non-empty string`, id);
  }
  const source = parseSourceRequired(raw.source, ctx, index);
  const prompt = parseStringOrNull(raw.prompt, 'prompt', ctx, index);
  const description = parseStringOrNull(raw.description, 'description', ctx, index);
  const aspectRatio = parseAspectRatioOrNull(raw.aspectRatio, ctx, index);
  const width = parseNumberOrNull(raw.width, 'width', ctx, index);
  const height = parseNumberOrNull(raw.height, 'height', ctx, index);
  const actionType = parseActionTypeOrNull(raw.actionType, ctx, index);
  const variantGroupId = parseVariantGroupIdOrNull(raw.variantGroupId, ctx, index);
  const status = parseGenStatusOrNull(raw.status, ctx, index);
  const workspaceId = parseStringOrNull(raw.workspaceId, 'workspaceId', ctx, index);
  const workspaceName = raw.workspaceName;
  if (typeof workspaceName !== 'string') {
    throw new BloomApiParseError(ctx, `images[${index}].workspaceName must be a string`, workspaceName);
  }
  const createdAt = raw.createdAt;
  if (typeof createdAt !== 'string') {
    throw new BloomApiParseError(ctx, `images[${index}].createdAt must be a string (date-time)`, createdAt);
  }
  const row: BloomImageListItem = {
    id,
    source,
    prompt,
    description,
    aspectRatio,
    width,
    height,
    actionType,
    variantGroupId,
    status,
    workspaceId,
    workspaceName,
    createdAt,
  };
  if ('brandSessionId' in raw && raw.brandSessionId !== undefined && raw.brandSessionId !== null) {
    if (typeof raw.brandSessionId !== 'string') {
      throw new BloomApiParseError(ctx, `images[${index}].brandSessionId must be a string when present`, raw.brandSessionId);
    }
    row.brandSessionId = raw.brandSessionId;
  }
  if ('imageUrl' in raw) {
    const u = raw.imageUrl;
    if (u !== null && u !== undefined && typeof u !== 'string') {
      throw new BloomApiParseError(ctx, `images[${index}].imageUrl must be string or null`, u);
    }
    row.imageUrl = u as string | null | undefined;
  }
  return row;
}

/** Validates GET /images/{id} `data` per OpenAPI required keys. */
export function parseGetImageEnvelope(body: unknown, ctx = 'GET /images/{id}'): BloomImageGetData {
  const d = requireEnvelope(body, ctx);
  for (const k of GET_IMAGE_REQUIRED_KEYS) {
    requireImageKey(d, k, ctx, null);
  }
  const id = d.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new BloomApiParseError(ctx, 'data.id must be a non-empty string', id);
  }
  if (typeof d.workspaceName !== 'string') {
    throw new BloomApiParseError(ctx, 'data.workspaceName must be a string', d.workspaceName);
  }
  if (typeof d.createdAt !== 'string') {
    throw new BloomApiParseError(ctx, 'data.createdAt must be a string (date-time)', d.createdAt);
  }
  return {
    id,
    source: parseSourceRequired(d.source, ctx, null),
    status: parseGenStatusOrNull(d.status, ctx, null),
    prompt: parseStringOrNull(d.prompt, 'prompt', ctx, null),
    description: parseStringOrNull(d.description, 'description', ctx, null),
    imageUrl: parseStringOrNull(d.imageUrl, 'imageUrl', ctx, null),
    aspectRatio: parseAspectRatioOrNull(d.aspectRatio, ctx, null),
    width: parseNumberOrNull(d.width, 'width', ctx, null),
    height: parseNumberOrNull(d.height, 'height', ctx, null),
    actionType: parseActionTypeOrNull(d.actionType, ctx, null),
    variantGroupId: parseVariantGroupIdOrNull(d.variantGroupId, ctx, null),
    workspaceId: parseStringOrNull(d.workspaceId, 'workspaceId', ctx, null),
    workspaceName: d.workspaceName,
    createdAt: d.createdAt,
  };
}

/**
 * Treats missing/null image status as pending for polling logic.
 * @param row Parsed image row from list or get-by-id.
 */
export function effectiveImageGenStatus(row: BloomImageListItem | BloomImageGetData): BloomImageGenStatus {
  const s = row.status;
  if (s === null || s === undefined) return 'pending';
  return s;
}

/** Validates GET /images list `data` (`images`, pagination, required image fields). */
export function parseImagesListEnvelope(body: unknown, ctx = 'GET /images'): BloomImagesListData {
  const d = requireEnvelope(body, ctx);
  if (!Array.isArray(d.images)) {
    throw new BloomApiParseError(ctx, 'data.images must be an array', d.images);
  }
  if (typeof d.hasMore !== 'boolean') {
    throw new BloomApiParseError(ctx, 'data.hasMore must be a boolean', d.hasMore);
  }
  const nc = d.nextCursor;
  if (!(typeof nc === 'string' || nc === null)) {
    throw new BloomApiParseError(ctx, 'data.nextCursor must be string or null', nc);
  }
  const images = d.images.map((item, i) => parseImageListItem(item, ctx, i));
  return { images, nextCursor: nc, hasMore: d.hasMore };
}

// --- POST generations / edit ---

export interface BloomGenerationAcceptedData {
  ids: string[];
  variantGroupId: string | null;
  status: 'pending';
}

/** Validates POST /images/generations accepted response (`ids`, `variantGroupId`, `status`). */
export function parseGenerationAcceptedEnvelope(body: unknown, ctx = 'POST /images/generations'): BloomGenerationAcceptedData {
  const d = requireEnvelope(body, ctx);
  const idsRaw = d.ids;
  if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
    throw new BloomApiParseError(ctx, 'data.ids must be a non-empty array', idsRaw);
  }
  const ids = idsRaw.map((x, i) => {
    if (typeof x !== 'string' || x.length === 0) {
      throw new BloomApiParseError(ctx, `data.ids[${i}] must be a non-empty string`, x);
    }
    return x;
  });
  if (!('variantGroupId' in d)) {
    throw new BloomApiParseError(ctx, 'data.variantGroupId is required', d);
  }
  const vgid = d.variantGroupId;
  if (vgid !== null && (typeof vgid !== 'string' || vgid.length === 0)) {
    throw new BloomApiParseError(ctx, 'data.variantGroupId must be uuid string or null', vgid);
  }
  if (d.status !== 'pending') {
    throw new BloomApiParseError(ctx, 'data.status must be "pending"', d.status);
  }
  return { ids, variantGroupId: vgid as string | null, status: 'pending' };
}

export interface BloomEditAcceptedData {
  id: string;
  status: 'pending';
}

/** Validates POST /images/{id}/edit accepted response (`id`, `status`). */
export function parseEditAcceptedEnvelope(body: unknown, ctx = 'POST /images/{id}/edit'): BloomEditAcceptedData {
  const d = requireEnvelope(body, ctx);
  const id = d.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new BloomApiParseError(ctx, 'data.id must be a non-empty string', id);
  }
  if (d.status !== 'pending') {
    throw new BloomApiParseError(ctx, 'data.status must be "pending"', d.status);
  }
  return { id, status: 'pending' };
}

// --- Credits ---

export interface BloomCreditsData {
  balance: number;
  unlimited: boolean;
}

/** Validates GET /credits `data` (`balance`, `unlimited`). */
export function parseCreditsEnvelope(body: unknown, ctx = 'GET /credits'): BloomCreditsData {
  const d = requireEnvelope(body, ctx);
  if (typeof d.unlimited !== 'boolean') {
    throw new BloomApiParseError(ctx, 'data.unlimited must be a boolean', d.unlimited);
  }
  if (d.unlimited) {
    const b = d.balance;
    const balance = typeof b === 'number' && Number.isFinite(b) ? b : 0;
    return { balance, unlimited: true };
  }
  const balance = d.balance;
  if (typeof balance !== 'number' || !Number.isFinite(balance)) {
    throw new BloomApiParseError(ctx, 'data.balance must be a finite number when unlimited is false', balance);
  }
  return { balance, unlimited: false };
}

/** Map API brand row to plugin-facing model (brandSessionId === id per API docs). */
export interface BloomBrand extends BloomBrandDetailData {
  brandSessionId: string;
}

/**
 * Adds `brandSessionId` alias equal to brand `id` for plugin code paths.
 * @param row Parsed brand list or detail row.
 */
export function toBloomBrand(row: BloomBrandListItem | BloomBrandDetailData): BloomBrand {
  return { ...row, brandSessionId: row.id };
}
