// Shared mutable state for the plugin UI, plus the postMessage bridge and toast helper.

export function postToCode(payload: unknown): void {
  parent.postMessage({ pluginMessage: payload }, '*');
}

let _toastTimer: ReturnType<typeof setTimeout> | null = null;

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

export interface GenerateSnapshot {
  basePrompt: string;
  effectiveRatio: string;
  variantCount: number;
}

export interface ResultItem {
  id: string;
  imageUrl: string;
  aspectRatio: string;
}

export interface LibraryRow {
  id: string;
  imageUrl: string;
  aspectRatio: string;
  insertPrompt: string;
}

export interface BatchFrame {
  id: string;
  width: number;
  height: number;
}

export const state = {
  currentViewId: 'setup',

  savedBrandId: null as string | null,
  selectedBrandId: null as string | null,
  _loadBrandsGen: 0,

  frameWidth: null as number | null,
  frameHeight: null as number | null,
  frameName: '',
  frameId: null as string | null,
  isReplaceMode: false,
  isBatchMode: false,
  batchFrames: [] as BatchFrame[],

  selectedRatio: 'auto',
  variantCount: 1,

  _generationRunning: false,
  lastPromptForInsert: '',
  lastGenerateSnapshot: null as GenerateSnapshot | null,
  styleReferenceDataUrl: null as string | null,
  _editRunning: false,

  generationResults: [] as ResultItem[],
  selectedImageId: null as string | null,

  libraryRows: [] as LibraryRow[],
  libraryOutgoingCursor: null as string | null,
  libraryHasMore: false,
  _libraryLoading: false,
  librarySelectedId: null as string | null,
  _libraryLoadGen: 0,

  zoomContext: 'results' as 'results' | 'library',
  zoomOpenIndex: 0,

  _insertFlashTimer: null as ReturnType<typeof setTimeout> | null,
  _batchWaitResolve: null as (() => void) | null,
  _batchWaitReject: null as ((err: Error) => void) | null,
};

export function getApiKey(): string {
  const input = document.getElementById('api-key-input') as HTMLInputElement | null;
  return input ? input.value.trim() : '';
}

export function getBrandSessionId(): string {
  return state.savedBrandId || state.selectedBrandId || '';
}

// Appended to prompts when a style-reference image is captured from the canvas.
export const STYLE_REF_SUFFIX =
  '\n\nStyle reference: Match the color palette, lighting, and overall visual mood of the user-selected reference image from the canvas.';

export const PROMPT_MAX = 500;
