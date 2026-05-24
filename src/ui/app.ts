/**
 * @file Bloom plugin UI — application logic, view controller, and bootstrap.
 *
 * Responsibilities:
 *  - View navigation (showView)
 *  - Setup view: API key validation and persistence
 *  - Brand picker: listing, onboarding, selection
 *  - Generator: prompt handling, aspect-ratio, generation and batch flows
 *  - Results: insert, edit, regenerate
 *  - Library: pagination, insert
 *  - Zoom overlay: open/close/navigate
 *  - postMessage handler (code.ts → UI)
 *  - Event listener wiring
 *  - Plugin bootstrap
 */

import {
  state,
  postToCode,
  showToast,
  getApiKey,
  getBrandSessionId,
  STYLE_REF_SUFFIX,
} from './state';

import {
  validateApiKey,
  listBrands,
  onboardBrand,
  getBrand,
  generateImages,
  editImage,
  pollImages,
  listBrandCompletedImagesPage,
  mapListRowToLibraryItem,
  getCredits,
  getImageUrl,
  type Brand,
} from './client';

import {
  renderVariants,
  renderRatios,
  renderFramePill,
  syncPromptUi,
  updateStyleRefUi,
  setGeneratingTitle,
  setGeneratingProgress,
  showResults,
  renderLibraryGrid,
  syncResultsGridSelection,
  syncLibraryGridSelection,
  syncBrandSelectionUi,
  setBrandContinueEnabled,
  setBrandListError,
  setOnboardStatusVisible,
  renderBrandSkeletons,
  formatBrandStatus,
  setApiKeyError,
  setConnectLoading,
  flashInsertButton,
  findResultCellByImageId,
  markImageCellUnavailable,
  getEffectiveAspectRatio,
  detectAspectRatio,
} from './render';

// =============================================================================
// View navigation
// =============================================================================

/**
 * Shows one view and hides all others.
 * Triggers side-effects for views that need data on entry
 * (e.g. brand list reload, selection refresh, library load).
 */
export function showView(id: string): void {
  state.currentViewId = id;
  document.querySelectorAll<HTMLElement>('#app-stage .view').forEach((el) => {
    el.style.display = el.id === id ? 'flex' : 'none';
  });

  if (id === 'brand-select') {
    void loadBrands();
  }
  if (id === 'generator') {
    requestSelection();
    void loadCredits();
    renderFramePill();
    renderVariants();
    renderRatios();
    updateStyleRefUi();
    syncPromptUi();
  }
  if (id === 'library') {
    void openLibraryView();
  }
}

// =============================================================================
// Setup view — API key
// =============================================================================

/**
 * Validates the entered API key, persists it via code.ts, and advances to brand-select.
 */
function onConnectClick(): void {
  const input = document.getElementById('api-key-input') as HTMLInputElement | null;
  if (!input) return;
  const key = input.value.trim();
  setApiKeyError('');
  if (!key) {
    setApiKeyError('Please enter your Bloom API key.');
    return;
  }
  setConnectLoading(true);
  validateApiKey(key)
    .then((ok) => {
      setConnectLoading(false);
      if (ok) {
        postToCode({ type: 'SAVE_KEY', key });
        showView('brand-select');
        showToast('API key saved');
      } else {
        setApiKeyError('That API key is not valid. Check the key and try again.');
      }
    })
    .catch((err: unknown) => {
      setConnectLoading(false);
      showToast(err instanceof Error ? err.message : "Couldn't verify your key. Check your network.", true);
    });
}

// =============================================================================
// Brand picker
// =============================================================================

/**
 * Decides which brand should be highlighted when the list first loads.
 * Prefers the currently in-session selection, then the last persisted brand.
 */
function pickInitialSelection(brands: Brand[]): string | null {
  if (state.selectedBrandId && brands.some((b) => b.id === state.selectedBrandId)) {
    return state.selectedBrandId;
  }
  if (state.savedBrandId && brands.some((b) => b.id === state.savedBrandId)) {
    return state.savedBrandId;
  }
  return null;
}

/**
 * Fetches brands from the Bloom API and renders them as selectable cards.
 * Shows skeleton placeholders while loading.
 */
async function loadBrands(): Promise<void> {
  const gen = ++state._loadBrandsGen;
  const listEl = document.getElementById('brand-list');
  if (!listEl) return;

  const apiKey = getApiKey();
  setBrandListError('');

  if (!apiKey) {
    listEl.innerHTML = '';
    setBrandListError('No API key. Go back and connect your account.');
    state.selectedBrandId = null;
    setBrandContinueEnabled(false);
    return;
  }

  renderBrandSkeletons(listEl, 4);

  try {
    const brands = await listBrands(apiKey);
    if (gen !== state._loadBrandsGen) return;

    listEl.innerHTML = '';

    if (brands.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'No brands yet. Add one using a website URL below.';
      listEl.appendChild(empty);
      state.selectedBrandId = null;
      setBrandContinueEnabled(false);
      return;
    }

    state.selectedBrandId = pickInitialSelection(brands);

    for (const brand of brands) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'brand-card';
      btn.setAttribute('role', 'listitem');
      btn.setAttribute('data-brand-id', brand.id);
      btn.setAttribute('aria-pressed', state.selectedBrandId === brand.id ? 'true' : 'false');
      if (state.selectedBrandId === brand.id) btn.classList.add('is-selected');

      const nameEl = document.createElement('span');
      nameEl.className = 'brand-card__name';
      nameEl.textContent = brand.name || 'Untitled brand';

      const urlEl = document.createElement('span');
      urlEl.className = 'brand-card__url';
      urlEl.textContent = brand.url || '—';

      btn.appendChild(nameEl);
      btn.appendChild(urlEl);

      const meta = formatBrandStatus(brand.status);
      if (meta) {
        const metaEl = document.createElement('span');
        metaEl.className = 'brand-card__meta';
        metaEl.textContent = meta;
        btn.appendChild(metaEl);
      }

      btn.addEventListener('click', () => {
        state.selectedBrandId = brand.id;
        syncBrandSelectionUi();
      });

      listEl.appendChild(btn);
    }

    syncBrandSelectionUi();
  } catch (err: unknown) {
    if (gen !== state._loadBrandsGen) return;
    listEl.innerHTML = '';
    setBrandListError(err instanceof Error ? err.message : String(err));
    state.selectedBrandId = null;
    setBrandContinueEnabled(false);
  }
}

/**
 * Submits a new brand URL to Bloom, polls until the brand is ready,
 * then refreshes the brand list and auto-selects the new brand.
 */
async function onAddBrandFromUrl(): Promise<void> {
  const urlInput = document.getElementById('brand-url-input') as HTMLInputElement | null;
  const addBtn = document.getElementById('btn-brand-add') as HTMLButtonElement | null;
  const raw = urlInput ? urlInput.value.trim() : '';
  if (!raw) { showToast('Enter a website URL', true); return; }

  const apiKey = getApiKey();
  if (!apiKey) { showToast('Connect your API key first', true); return; }

  if (addBtn) addBtn.disabled = true;
  setBrandListError('');
  setOnboardStatusVisible(true);

  try {
    const created = await onboardBrand(apiKey, raw);

    if (created.status === 'ready') {
      setOnboardStatusVisible(false);
      state.selectedBrandId = created.id;
      await loadBrands();
      if (urlInput) urlInput.value = '';
      showToast('Brand added');
      if (addBtn) addBtn.disabled = false;
      return;
    }

    const brandId = created.id;
    if (!brandId) throw new Error('Bloom API did not return a brand id');

    const deadline = Date.now() + 600_000;
    let last = created;

    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 2000));
      last = await getBrand(apiKey, brandId);

      if (last.status === 'ready') break;

      if (last.status === 'failed') throw new Error('Brand analysis failed');

      if (last.status === 'logo_required') {
        setOnboardStatusVisible(false);
        state.selectedBrandId = last.id;
        await loadBrands();
        if (urlInput) urlInput.value = '';
        showToast('Brand needs a logo in Bloom', true);
        if (addBtn) addBtn.disabled = false;
        return;
      }
    }

    if (last.status !== 'ready') throw new Error('Timed out waiting for brand to be ready');

    setOnboardStatusVisible(false);
    state.selectedBrandId = last.id;
    await loadBrands();
    if (urlInput) urlInput.value = '';
    showToast('Brand ready');
  } catch (e: unknown) {
    setOnboardStatusVisible(false);
    const em = e instanceof Error ? e.message : String(e);
    setBrandListError(em);
    showToast(em, true);
  } finally {
    if (addBtn) addBtn.disabled = false;
  }
}

/** Confirms the selected brand, persists it, and navigates to the generator. */
function onBrandContinueClick(): void {
  if (!state.selectedBrandId) { showToast('Select a brand first', true); return; }
  state.savedBrandId = state.selectedBrandId;
  postToCode({ type: 'SAVE_BRAND', brandId: state.selectedBrandId });
  showView('generator');
}

// =============================================================================
// Generator — credits & prompt helpers
// =============================================================================

/** Sends GET_SELECTION to code.ts to refresh the current canvas selection. */
function requestSelection(): void {
  postToCode({ type: 'GET_SELECTION' });
}

/** Fetches credit balance and updates the credits label. */
async function loadCredits(): Promise<void> {
  const el = document.getElementById('credits');
  if (!el) return;
  const apiKey = getApiKey();
  if (!apiKey) { el.textContent = 'Credits: —'; return; }
  try {
    const balance = await getCredits(apiKey);
    el.textContent =
      balance >= Number.MAX_SAFE_INTEGER / 2 ? 'Credits: Unlimited' : `Credits: ${balance}`;
  } catch (e: unknown) {
    el.textContent = 'Credits: unavailable';
    showToast(`Couldn't load credits: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

/** Appends the style-reference suffix to the prompt when a canvas image is captured. */
function buildApiPrompt(baseText: string): string {
  const trimmed = (baseText || '').trim();
  return state.styleReferenceDataUrl ? trimmed + STYLE_REF_SUFFIX : trimmed;
}

// =============================================================================
// Generation flow
// =============================================================================

/**
 * Core generation pipeline:
 * 1. POST /images/generations
 * 2. Poll until all images complete
 * 3. Populate results grid and navigate to the results view
 */
async function runGenerationCore(
  apiPrompt: string,
  insertPromptLabel: string,
  effectiveRatio: string,
  vc: number,
): Promise<void> {
  const apiKey = getApiKey();
  const brandSessionId = getBrandSessionId();
  if (!apiKey || !brandSessionId || !apiPrompt.trim()) {
    showToast('Add API key, brand, and a prompt', true);
    return;
  }

  state.lastPromptForInsert = insertPromptLabel;
  state._generationRunning = true;
  syncPromptUi();
  setGeneratingTitle('Generating…');
  showView('generating');
  setGeneratingProgress(0);

  try {
    const ids = await generateImages(apiKey, brandSessionId, apiPrompt, effectiveRatio, vc);
    const images = await pollImages(apiKey, brandSessionId, ids, setGeneratingProgress);

    state.generationResults = images.map((im) => ({
      id: String(im.id ?? ''),
      imageUrl: im.imageUrl != null ? getImageUrl(String(im.imageUrl)) : '',
      aspectRatio: effectiveRatio,
    }));
    state.lastGenerateSnapshot = {
      basePrompt: insertPromptLabel,
      effectiveRatio,
      variantCount: vc,
    };

    showResults(openZoom.bind(null, 'results'));
    showView('results');
    void loadCredits();
  } catch (err: unknown) {
    showToast(err instanceof Error ? err.message : String(err), true);
    showView('generator');
  } finally {
    state._generationRunning = false;
    syncPromptUi();
  }
}

/** Reads the prompt field and starts a standard (non-batch) generation run. */
async function runGeneration(): Promise<void> {
  const ta = document.getElementById('prompt-input') as HTMLTextAreaElement | null;
  const base = ta ? ta.value.trim() : '';
  if (!base) { showToast('Enter a prompt', true); return; }
  await runGenerationCore(buildApiPrompt(base), base, getEffectiveAspectRatio(), state.variantCount);
}

/** Re-runs generation using the last successful snapshot and current style reference. */
function onRegenerateClick(): void {
  if (state._generationRunning || !state.lastGenerateSnapshot) return;
  const snap = state.lastGenerateSnapshot;
  void runGenerationCore(buildApiPrompt(snap.basePrompt), snap.basePrompt, snap.effectiveRatio, snap.variantCount);
}

// =============================================================================
// Batch generation
// =============================================================================

/** Resolves the batch-insert Promise created by waitForBatchComplete(). */
function waitForBatchComplete(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    state._batchWaitResolve = resolve;
    state._batchWaitReject = reject;
  });
}

/**
 * Batch mode: generates one image per selected frame (in series),
 * then sends BATCH_INSERT to code.ts with all results.
 */
async function runBatchGeneration(): Promise<void> {
  const apiKey = getApiKey();
  const brandSessionId = getBrandSessionId();
  const ta = document.getElementById('prompt-input') as HTMLTextAreaElement | null;
  const prompt = ta ? ta.value.trim() : '';

  if (!apiKey || !brandSessionId || !prompt) {
    showToast('Add API key, brand, and a prompt', true);
    return;
  }
  if (!state.batchFrames.length) {
    showToast('Select multiple frames', true);
    return;
  }

  state.lastPromptForInsert = prompt;
  state._generationRunning = true;
  syncPromptUi();
  setGeneratingTitle('Generating…');
  showView('generating');
  setGeneratingProgress(0);

  const totalFrames = state.batchFrames.length;
  let framesDone = 0;
  const apiPrompt = buildApiPrompt(prompt);

  try {
    const items: { frameId: string; imageUrl: string; prompt: string; aspectRatio: string }[] = [];

    for (const fr of state.batchFrames) {
      const ratio = detectAspectRatio(fr.width, fr.height);
      const ids = await generateImages(apiKey, brandSessionId, apiPrompt, ratio, 1);
      const imgs = await pollImages(apiKey, brandSessionId, ids, (p) => {
        setGeneratingProgress(Math.round(((framesDone + p / 100) / totalFrames) * 100));
      });
      const first = imgs[0];
      if (!first || !first.imageUrl) throw new Error('Missing image URL for frame');
      items.push({
        frameId: String(fr.id),
        imageUrl: getImageUrl(String(first.imageUrl)),
        prompt,
        aspectRatio: ratio,
      });
      framesDone += 1;
      setGeneratingProgress(Math.round((framesDone / totalFrames) * 100));
    }

    const donePromise = waitForBatchComplete();
    postToCode({ type: 'BATCH_INSERT', items });
    await donePromise;
    showToast('Inserted into frames');
    showView('generator');
    void loadCredits();
  } catch (err: unknown) {
    showToast(err instanceof Error ? err.message : String(err), true);
    showView('generator');
  } finally {
    state._generationRunning = false;
    state._batchWaitResolve = null;
    state._batchWaitReject = null;
    syncPromptUi();
    setGeneratingProgress(0);
    setGeneratingTitle('Generating…');
  }
}

/** Dispatches to batch or single generation based on current selection mode. */
function onGenerateClick(): void {
  if (state._generationRunning) return;
  if (state.isBatchMode) void runBatchGeneration();
  else void runGeneration();
}

// =============================================================================
// Results — selection and insert
// =============================================================================

function getSelectedResult() {
  return (
    state.generationResults.find((r) => r.id === state.selectedImageId) ??
    (state.generationResults.length > 0 ? state.generationResults[0] : null)
  );
}

function getSelectedImageUrl(): string {
  const r = getSelectedResult();
  return r?.imageUrl ?? '';
}

function getSelectedResultAspectRatio(): string {
  return getSelectedResult()?.aspectRatio ?? '1:1';
}

/** Inserts or replaces the selected generation result on the Figma canvas. */
function onInsertSelectedClick(): void {
  const url = getSelectedImageUrl();
  if (!url) { showToast('Select an image', true); return; }
  const pr =
    state.lastPromptForInsert ||
    (document.getElementById('prompt-input') as HTMLTextAreaElement | null)?.value.trim() ||
    '';
  const ratio = getSelectedResultAspectRatio();
  if (state.isReplaceMode && state.frameId) {
    postToCode({ type: 'REPLACE_IMAGE', nodeId: state.frameId, imageUrl: getImageUrl(url) });
  } else {
    postToCode({ type: 'INSERT_IMAGE', imageUrl: getImageUrl(url), prompt: pr, aspectRatio: ratio });
  }
}

/** Returns to the generator view for a fresh generation. */
function onNewGenerationClick(): void {
  closeZoom();
  showView('generator');
}

// =============================================================================
// Edit panel
// =============================================================================

/** Toggles visibility of the inline edit-instruction panel. */
function onEditToggleClick(): void {
  const panel = document.getElementById('edit-panel');
  const btn = document.getElementById('btn-edit-toggle');
  if (!panel || !btn) return;
  panel.classList.toggle('is-hidden');
  btn.setAttribute('aria-expanded', panel.classList.contains('is-hidden') ? 'false' : 'true');
}

/**
 * Submits an edit instruction for the selected image,
 * then replaces that result in the grid when done.
 */
async function onApplyEditClick(): Promise<void> {
  if (state._editRunning || state._generationRunning) return;
  const sel = getSelectedResult();
  const instEl = document.getElementById('edit-instruction') as HTMLTextAreaElement | null;
  const instruction = instEl ? instEl.value.trim() : '';
  if (!sel || !instruction) {
    showToast('Select an image and describe your edit', true);
    return;
  }
  const apiKey = getApiKey();
  const brandSessionId = getBrandSessionId();
  if (!apiKey || !brandSessionId) { showToast('Add API key and brand', true); return; }

  state._editRunning = true;
  const applyBtn = document.getElementById('btn-apply-edit') as HTMLButtonElement | null;
  if (applyBtn) applyBtn.disabled = true;
  setGeneratingTitle('Generating…');
  showView('generating');
  setGeneratingProgress(0);

  try {
    const ids = await editImage(apiKey, brandSessionId, sel.id, instruction);
    const images = await pollImages(apiKey, brandSessionId, ids, setGeneratingProgress);
    const done = images[0];
    if (!done?.imageUrl) throw new Error('Edit finished without an image URL');

    const newUrl = getImageUrl(String(done.imageUrl));
    const idx = state.generationResults.findIndex((r) => r.id === sel.id);
    if (idx >= 0) {
      state.generationResults[idx] = {
        id: String(done.id ?? ''),
        imageUrl: newUrl,
        aspectRatio: state.generationResults[idx].aspectRatio,
      };
      state.selectedImageId = String(done.id ?? '');
    }

    setGeneratingTitle('Generating…');
    showResults(openZoom.bind(null, 'results'));
    showView('results');
    void loadCredits();
    if (instEl) instEl.value = '';
  } catch (e: unknown) {
    showToast(e instanceof Error ? e.message : String(e), true);
    showView('results');
  } finally {
    state._editRunning = false;
    if (applyBtn) applyBtn.disabled = false;
  }
}

// =============================================================================
// Style reference
// =============================================================================

/** Requests a data URL for the selected canvas image (for style reference). */
function onStyleRefCaptureClick(): void {
  postToCode({ type: 'GET_SELECTED_IMAGE_URL' });
}

/** Clears the captured style reference and resets the preview. */
function onStyleRefClearClick(): void {
  state.styleReferenceDataUrl = null;
  updateStyleRefUi();
}

// =============================================================================
// Library view
// =============================================================================

/** Resets library state and loads the first page of completed generated images. */
async function openLibraryView(): Promise<void> {
  const errEl = document.getElementById('library-error');
  if (errEl) { errEl.textContent = ''; errEl.classList.remove('is-visible'); }

  state.libraryRows = [];
  state.libraryOutgoingCursor = null;
  state.libraryHasMore = false;
  state.librarySelectedId = null;
  state._libraryLoadGen += 1;
  const gen = state._libraryLoadGen;

  renderLibraryGrid(openZoom.bind(null, 'library'));

  const apiKey = getApiKey();
  const brandSessionId = getBrandSessionId();
  if (!apiKey || !brandSessionId) {
    if (errEl) {
      errEl.textContent = 'Add an API key and choose a brand first.';
      errEl.classList.add('is-visible');
    }
    return;
  }

  await loadLibraryNextPage(gen);
}

/** Fetches the next page of library images; guards against stale loads. */
async function loadLibraryNextPage(gen = state._libraryLoadGen): Promise<void> {
  if (gen !== state._libraryLoadGen) return;
  if (state._libraryLoading) return;
  if (state.libraryRows.length > 0 && !state.libraryHasMore) return;

  const apiKey = getApiKey();
  const brandSessionId = getBrandSessionId();
  if (!apiKey || !brandSessionId) return;

  const loadMoreBtn = document.getElementById('btn-library-load-more') as HTMLButtonElement | null;
  const errPanel = document.getElementById('library-error');

  state._libraryLoading = true;
  if (loadMoreBtn) loadMoreBtn.disabled = true;

  try {
    const cursorForRequest = state.libraryRows.length === 0 ? null : state.libraryOutgoingCursor;
    const page = await listBrandCompletedImagesPage(apiKey, brandSessionId, cursorForRequest);
    if (gen !== state._libraryLoadGen) return;

    const seen = new Set(state.libraryRows.map((r) => r.id));
    for (const img of page.images) {
      const mapped = mapListRowToLibraryItem(img);
      if (seen.has(mapped.id)) continue;
      seen.add(mapped.id);
      state.libraryRows.push(mapped);
    }

    state.libraryOutgoingCursor =
      typeof page.nextCursor === 'string' && page.nextCursor.length > 0 ? page.nextCursor : null;
    state.libraryHasMore = !!page.hasMore;

    if (!state.librarySelectedId && state.libraryRows.length > 0) {
      state.librarySelectedId = state.libraryRows[0].id;
    }

    if (errPanel) {
      if (state.libraryRows.length === 0) {
        errPanel.textContent = 'No completed generated images for this brand yet.';
        errPanel.classList.add('is-visible');
      } else {
        errPanel.textContent = '';
        errPanel.classList.remove('is-visible');
      }
    }

    renderLibraryGrid(openZoom.bind(null, 'library'));
  } catch (e: unknown) {
    if (gen !== state._libraryLoadGen) return;
    const em = e instanceof Error ? e.message : String(e);
    showToast(em, true);
    if (errPanel) { errPanel.textContent = em; errPanel.classList.add('is-visible'); }
  } finally {
    if (gen !== state._libraryLoadGen) return;
    state._libraryLoading = false;
    if (loadMoreBtn) loadMoreBtn.disabled = !state.libraryHasMore;
  }
}

function getSelectedLibraryRow() {
  return (
    state.libraryRows.find((r) => r.id === state.librarySelectedId) ??
    (state.libraryRows.length > 0 ? state.libraryRows[0] : null)
  );
}

/** Inserts the selected library image into the canvas. */
function onLibraryInsertClick(): void {
  if (state.isBatchMode && state.batchFrames.length > 0) {
    showToast(
      'Library insert works with a single frame. Deselect extra frames or use Generate for batch.',
      true,
    );
    return;
  }
  const row = getSelectedLibraryRow();
  if (!row?.imageUrl) { showToast('Select an image', true); return; }
  const url = row.imageUrl;
  const pr = row.insertPrompt || 'Library image';
  const ratio = row.aspectRatio || '1:1';
  if (state.isReplaceMode && state.frameId) {
    postToCode({ type: 'REPLACE_IMAGE', nodeId: state.frameId, imageUrl: getImageUrl(url) });
  } else {
    postToCode({ type: 'INSERT_IMAGE', imageUrl: getImageUrl(url), prompt: pr, aspectRatio: ratio });
  }
}

function onLibraryBackClick(): void {
  closeZoom();
  showView('generator');
}

// =============================================================================
// Zoom overlay
// =============================================================================

function isZoomOverlayOpen(): boolean {
  const ov = document.getElementById('zoom-overlay');
  return !!(ov?.classList.contains('is-open'));
}

/** Opens the full-screen zoom viewer for results or library at a given index. */
function openZoom(context: 'results' | 'library', index: number): void {
  const rows = context === 'library' ? state.libraryRows : state.generationResults;
  if (!rows.length) return;
  const clamped = Math.max(0, Math.min(rows.length - 1, index));
  state.zoomOpenIndex = clamped;
  state.zoomContext = context;
  const r = rows[clamped];
  const img = document.getElementById('zoom-overlay-img') as HTMLImageElement | null;
  const ov = document.getElementById('zoom-overlay');
  if (img && r.imageUrl) img.src = getImageUrl(r.imageUrl);
  if (ov) { ov.classList.add('is-open'); ov.setAttribute('aria-hidden', 'false'); }
  updateZoomNavState();
}

function closeZoom(): void {
  const ov = document.getElementById('zoom-overlay');
  if (ov) { ov.classList.remove('is-open'); ov.setAttribute('aria-hidden', 'true'); }
}

function updateZoomNavState(): void {
  const n = (state.zoomContext === 'library' ? state.libraryRows : state.generationResults).length;
  const prev = document.getElementById('zoom-prev') as HTMLButtonElement | null;
  const next = document.getElementById('zoom-next') as HTMLButtonElement | null;
  if (prev) prev.disabled = n <= 1;
  if (next) next.disabled = n <= 1;
}

// =============================================================================
// postMessage handler (code.ts → UI)
// =============================================================================

/**
 * Handles all messages sent from the Figma main thread (code.ts).
 *
 * Messages handled:
 *   KEY_LOADED              — restore saved API key; validate and route to correct view
 *   KEY_SAVED               — no-op acknowledgement
 *   BRAND_LOADED            — store and apply saved brandId
 *   FRAME_SELECTED          — single frame selected on canvas
 *   IMAGE_LAYER_SELECTED    — image fill node selected (replace mode)
 *   MULTI_FRAME_SELECTED    — multiple frames selected (batch mode)
 *   NO_FRAME_SELECTED       — selection cleared or non-frame selection
 *   INSERT_SUCCESS          — flash "Inserted" on insert button
 *   REPLACE_SUCCESS         — flash "Replaced" on insert button
 *   BATCH_COMPLETE          — resolves the batch-insert await
 *   INSERT_ERROR            — show error toast
 *   BATCH_ERROR             — reject batch-insert await or show error toast
 *   SELECTED_IMAGE_URL      — store data URL for style reference
 *   SELECTED_IMAGE_URL_ERROR — show style-reference error toast
 *   IMAGE_DATA_RESULT       — update thumbnail src after CORS-free fetch
 *   IMAGE_DATA_ERROR        — mark thumbnail as unavailable
 *   PLUGIN_ERROR            — generic plugin error toast
 */
function onPluginMessage(event: MessageEvent): void {
  try {
    const msg = event.data?.pluginMessage as Record<string, unknown> | undefined;
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      // ---- auth ----
      case 'KEY_LOADED': {
        const input = document.getElementById('api-key-input') as HTMLInputElement | null;
        const key = msg.key != null ? String(msg.key) : '';
        if (input) input.value = key;
        if (!key) { showView('setup'); return; }
        setConnectLoading(true);
        validateApiKey(key)
          .then((ok) => {
            setConnectLoading(false);
            showView(ok ? 'brand-select' : 'setup');
            if (!ok) setApiKeyError('Saved API key is no longer valid. Enter a new key.');
          })
          .catch((err: unknown) => {
            setConnectLoading(false);
            showView('setup');
            const em = err instanceof Error ? err.message : String(err);
            setApiKeyError(
              em.includes("We couldn't reach Bloom")
                ? em
                : 'Could not validate saved key. Check your network.',
            );
          });
        break;
      }

      case 'KEY_SAVED':
        break;

      // ---- brand ----
      case 'BRAND_LOADED': {
        state.savedBrandId = msg.brandId != null ? String(msg.brandId) : null;
        if (state.currentViewId === 'brand-select' && state.savedBrandId && !state.selectedBrandId) {
          const listEl = document.getElementById('brand-list');
          if (listEl) {
            const card = Array.from(listEl.querySelectorAll('.brand-card')).find(
              (c) => c.getAttribute('data-brand-id') === state.savedBrandId,
            );
            if (card) {
              state.selectedBrandId = state.savedBrandId;
              syncBrandSelectionUi();
            }
          }
        }
        break;
      }

      // ---- canvas selection ----
      case 'FRAME_SELECTED':
        state.frameWidth = typeof msg.width === 'number' ? msg.width : null;
        state.frameHeight = typeof msg.height === 'number' ? msg.height : null;
        state.frameName = msg.name != null ? String(msg.name) : '';
        state.frameId = msg.frameId != null ? String(msg.frameId) : null;
        state.isReplaceMode = false;
        state.isBatchMode = false;
        state.batchFrames = [];
        renderFramePill();
        break;

      case 'IMAGE_LAYER_SELECTED':
        state.isReplaceMode = true;
        state.isBatchMode = false;
        state.batchFrames = [];
        state.frameWidth = typeof msg.width === 'number' ? msg.width : null;
        state.frameHeight = typeof msg.height === 'number' ? msg.height : null;
        state.frameName = msg.name != null ? String(msg.name) : '';
        state.frameId = msg.nodeId != null ? String(msg.nodeId) : null;
        renderFramePill();
        break;

      case 'MULTI_FRAME_SELECTED':
        state.isReplaceMode = false;
        state.isBatchMode = true;
        state.frameWidth = null;
        state.frameHeight = null;
        state.frameName = '';
        state.frameId = null;
        state.batchFrames = Array.isArray(msg.frames)
          ? (msg.frames as typeof state.batchFrames).slice()
          : [];
        renderFramePill();
        break;

      case 'NO_FRAME_SELECTED':
        state.frameWidth = null;
        state.frameHeight = null;
        state.frameName = '';
        state.frameId = null;
        state.isReplaceMode = false;
        state.isBatchMode = false;
        state.batchFrames = [];
        renderFramePill();
        break;

      // ---- insert / batch ----
      case 'INSERT_SUCCESS':
        flashInsertButton('Inserted');
        break;

      case 'REPLACE_SUCCESS':
        flashInsertButton('Replaced');
        break;

      case 'BATCH_COMPLETE':
        if (state._batchWaitResolve) {
          state._batchWaitResolve();
          state._batchWaitResolve = null;
          state._batchWaitReject = null;
        }
        break;

      case 'INSERT_ERROR':
        showToast(msg.message != null ? String(msg.message) : 'Insert failed', true);
        break;

      case 'BATCH_ERROR':
        if (state._batchWaitReject) {
          state._batchWaitReject(new Error(msg.message != null ? String(msg.message) : 'Batch failed'));
          state._batchWaitResolve = null;
          state._batchWaitReject = null;
        } else {
          showToast(msg.message != null ? String(msg.message) : 'Batch failed', true);
        }
        break;

      // ---- style reference ----
      case 'SELECTED_IMAGE_URL':
        if (msg.dataUrl != null && String(msg.dataUrl) !== '') {
          state.styleReferenceDataUrl = String(msg.dataUrl);
          updateStyleRefUi();
        }
        break;

      case 'SELECTED_IMAGE_URL_ERROR':
        showToast(
          msg.message != null && String(msg.message) !== ''
            ? String(msg.message)
            : 'Select an image layer with an image fill.',
          true,
        );
        break;

      // ---- image data (CORS fallback) ----
      case 'IMAGE_DATA_RESULT': {
        const dataUrlStr = msg.dataUrl != null ? String(msg.dataUrl) : '';
        const imageIdStr = msg.imageId != null ? String(msg.imageId) : '';
        if (!dataUrlStr || !imageIdStr) break;

        const cell = findResultCellByImageId(imageIdStr);
        if (!cell) break;
        const imgEl = cell.querySelector('img') as HTMLImageElement | null;
        if (imgEl) {
          imgEl.src = dataUrlStr;
          imgEl.style.cssText = 'display:block;width:100%;height:100%;object-fit:cover;position:relative;z-index:2';
          setTimeout(() => {
            Array.from(cell.children).forEach((child) => {
              if (child !== imgEl) { child.remove(); }
            });
            (cell as HTMLElement).style.background = 'transparent';
          }, 50);
        }

        const result = state.generationResults.find((r) => String(r.id ?? '') === imageIdStr);
        if (result) { result.imageUrl = dataUrlStr; }
        const libRow = state.libraryRows.find((r) => String(r.id ?? '') === imageIdStr);
        if (libRow) { libRow.imageUrl = dataUrlStr; }
        break;
      }

      case 'IMAGE_DATA_ERROR': {
        const failedId = msg.imageId != null ? String(msg.imageId) : '';
        if (failedId) markImageCellUnavailable(failedId);
        const fetchErr = msg.message != null ? String(msg.message) : '';
        if (fetchErr) showToast(`Could not load image preview: ${fetchErr}`, true);
        break;
      }

      case 'PLUGIN_ERROR': {
        const op = msg.operation != null ? String(msg.operation) : '';
        const pm = msg.message != null ? String(msg.message) : 'Plugin error';
        showToast(op ? `${op}: ${pm}` : pm, true);
        break;
      }

      default:
        break;
    }
  } catch (e: unknown) {
    showToast(e instanceof Error ? e.message : 'Something went wrong.', true);
  }
}

// =============================================================================
// Event listeners
// =============================================================================

function wireEvents(): void {
  // --- setup view ---
  document.getElementById('btn-setup-connect')?.addEventListener('click', onConnectClick);
  document.getElementById('btn-setup-back')?.addEventListener('click', () => {
    postToCode({ type: 'CLOSE' });
  });

  // --- brand picker ---
  document.getElementById('btn-brand-add')?.addEventListener('click', () => void onAddBrandFromUrl());
  document.getElementById('btn-brand-continue')?.addEventListener('click', onBrandContinueClick);
  document.getElementById('btn-brand-back')?.addEventListener('click', () => showView('setup'));

  // --- generator ---
  const promptInput = document.getElementById('prompt-input');
  if (promptInput) {
    promptInput.addEventListener('input', syncPromptUi);
    promptInput.addEventListener('paste', () => requestAnimationFrame(syncPromptUi));
  }
  document.getElementById('btn-generate')?.addEventListener('click', onGenerateClick);
  document.getElementById('btn-change-brand')?.addEventListener('click', () => showView('brand-select'));
  document.getElementById('btn-open-library')?.addEventListener('click', () => showView('library'));
  document.getElementById('btn-generator-back')?.addEventListener('click', () => showView('brand-select'));

  // --- style reference ---
  document.getElementById('btn-style-ref-capture')?.addEventListener('click', onStyleRefCaptureClick);
  document.getElementById('btn-style-ref-clear')?.addEventListener('click', onStyleRefClearClick);

  // --- results ---
  document.getElementById('btn-insert-selected')?.addEventListener('click', onInsertSelectedClick);
  document.getElementById('btn-new-generation')?.addEventListener('click', onNewGenerationClick);
  document.getElementById('btn-results-back')?.addEventListener('click', onNewGenerationClick);
  document.getElementById('btn-regenerate')?.addEventListener('click', onRegenerateClick);
  document.getElementById('btn-edit-toggle')?.addEventListener('click', onEditToggleClick);
  document.getElementById('btn-apply-edit')?.addEventListener('click', () => void onApplyEditClick());

  // --- library ---
  document.getElementById('btn-library-insert')?.addEventListener('click', onLibraryInsertClick);
  document.getElementById('btn-library-load-more')?.addEventListener('click', () => void loadLibraryNextPage());
  document.getElementById('btn-library-back')?.addEventListener('click', onLibraryBackClick);

  // --- zoom overlay ---
  document.getElementById('zoom-scrim')?.addEventListener('click', closeZoom);
  document.getElementById('zoom-close')?.addEventListener('click', closeZoom);

  document.getElementById('zoom-prev')?.addEventListener('click', () => {
    const rows = state.zoomContext === 'library' ? state.libraryRows : state.generationResults;
    if (rows.length <= 1) return;
    openZoom(state.zoomContext, (state.zoomOpenIndex - 1 + rows.length) % rows.length);
  });

  document.getElementById('zoom-next')?.addEventListener('click', () => {
    const rows = state.zoomContext === 'library' ? state.libraryRows : state.generationResults;
    if (rows.length <= 1) return;
    openZoom(state.zoomContext, (state.zoomOpenIndex + 1) % rows.length);
  });

  document.getElementById('zoom-select-this')?.addEventListener('click', () => {
    const rows = state.zoomContext === 'library' ? state.libraryRows : state.generationResults;
    const r = rows[state.zoomOpenIndex];
    if (!r) return;
    if (state.zoomContext === 'library') {
      state.librarySelectedId = r.id;
      syncLibraryGridSelection();
    } else {
      state.selectedImageId = r.id;
      syncResultsGridSelection();
    }
  });

  // --- global keyboard ---
  document.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key === 'Escape' && isZoomOverlayOpen()) {
      ev.preventDefault();
      closeZoom();
    }
  });

  // --- postMessage bridge ---
  window.addEventListener('message', onPluginMessage);
}

// =============================================================================
// Bootstrap
// =============================================================================

/**
 * Entry point called once when the UI bundle loads.
 * Shows the setup view, wires all event listeners, then asks code.ts to
 * restore any persisted API key and brand from Figma client storage.
 */
export function init(): void {
  wireEvents();
  showView('setup');
  postToCode({ type: 'LOAD_KEY' });
  postToCode({ type: 'LOAD_BRAND' });
}
