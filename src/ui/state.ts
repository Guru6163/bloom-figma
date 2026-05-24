/**
 * @file Shared mutable state for the Bloom plugin UI, plus low-level
 * infrastructure helpers (postMessage bridge, toast).
 *
 * All state lives on a single plain object so any module can mutate it
 * directly without ES-module binding restrictions.
 */

// ---------------------------------------------------------------------------
// Message bridge
// ---------------------------------------------------------------------------

/** Sends a structured message to code.ts via the Figma postMessage bridge. */
export function postToCode(payload: unknown): void {
  parent.postMessage({ pluginMessage: payload }, '*');
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let _toastTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Shows a brief notification at the bottom of the panel.
 * Auto-dismisses after 3 seconds.
 */
export function showToast(message: string, isError = false): void {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove('toast--error', 'toast--success');
  toast.classList.add(isError ? 'toast--error' : 'toast--success', 'is-visible');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    toast.classList.remove('is-visible', 'toast--error', 'toast--success');
    toast.textContent = '';
    _toastTimer = null;
  }, 3000);
}

// ---------------------------------------------------------------------------
// Shared state object
// ---------------------------------------------------------------------------

/** Snapshot captured before each generation run for the Regenerate action. */
export interface GenerateSnapshot {
  basePrompt: string;
  effectiveRatio: string;
  variantCount: number;
}

/** A single result from a generation or edit run. */
export interface ResultItem {
  id: string;
  imageUrl: string;
  aspectRatio: string;
}

/** A row in the library grid. */
export interface LibraryRow {
  id: string;
  imageUrl: string;
  aspectRatio: string;
  insertPrompt: string;
}

/** A frame entry passed in MULTI_FRAME_SELECTED from code.ts. */
export interface BatchFrame {
  id: string;
  width: number;
  height: number;
}

export const state = {
  // ----- navigation -----
  currentViewId: 'setup',

  // ----- auth / brand -----
  savedBrandId: null as string | null,
  selectedBrandId: null as string | null,
  _loadBrandsGen: 0,

  // ----- canvas selection -----
  frameWidth: null as number | null,
  frameHeight: null as number | null,
  frameName: '',
  frameId: null as string | null,
  isReplaceMode: false,
  isBatchMode: false,
  batchFrames: [] as BatchFrame[],

  // ----- generator controls -----
  selectedRatio: 'auto',
  variantCount: 1,

  // ----- generation run -----
  _generationRunning: false,
  lastPromptForInsert: '',
  lastGenerateSnapshot: null as GenerateSnapshot | null,
  styleReferenceDataUrl: null as string | null,
  _editRunning: false,

  // ----- results -----
  generationResults: [] as ResultItem[],
  selectedImageId: null as string | null,

  // ----- library -----
  libraryRows: [] as LibraryRow[],
  libraryOutgoingCursor: null as string | null,
  libraryHasMore: false,
  _libraryLoading: false,
  librarySelectedId: null as string | null,
  _libraryLoadGen: 0,

  // ----- zoom overlay -----
  zoomContext: 'results' as 'results' | 'library',
  zoomOpenIndex: 0,

  // ----- internal timers / callbacks -----
  _insertFlashTimer: null as ReturnType<typeof setTimeout> | null,
  _batchWaitResolve: null as (() => void) | null,
  _batchWaitReject: null as ((err: Error) => void) | null,
};

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/** Reads the API key from the setup input field. */
export function getApiKey(): string {
  const input = document.getElementById('api-key-input') as HTMLInputElement | null;
  return input ? input.value.trim() : '';
}

/** Returns the active brand session id (persisted → in-session → empty). */
export function getBrandSessionId(): string {
  return state.savedBrandId || state.selectedBrandId || '';
}

/** The suffix appended to prompts when a style-reference image is captured. */
export const STYLE_REF_SUFFIX =
  '\n\nStyle reference: Match the color palette, lighting, and overall visual mood of the user-selected reference image from the canvas.';

export const PROMPT_MAX = 500;
