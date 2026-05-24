# Bloom – Figma Plugin

Generate on-brand images inside Figma using the Bloom API.
Select a frame, describe what you need, and Bloom generates
images that match your brand's visual identity automatically.

## Features

- Generate on-brand images from any text prompt
- Auto-detects frame dimensions and maps to the correct aspect ratio
- Generate 1–5 variants at once
- Replace existing image fills in one click
- Batch-fill multiple frames simultaneously
- Use any canvas image as a style reference
- Edit generated images with text instructions
- Browse and reuse previously generated images from your Library

## How it works

1. Install the plugin in Figma Desktop
2. Connect your Bloom API key ([trybloom.ai/developers](https://www.trybloom.ai/developers))
3. Select your brand
4. Select a frame on your canvas
5. Describe what you want to generate
6. Click **Generate** — images appear on your canvas inside the selected frame

## Setup for development

### Prerequisites

- Node.js 18+
- Figma Desktop app

### Install

```bash
npm install
```

### Build

```bash
npm run build        # production build → dist/
npm run watch        # development build with watch mode
```

### Load in Figma

1. Run `npm run build` so `dist/code.js` and `dist/ui.html` exist
2. Open Figma Desktop
3. **Plugins → Development → Import plugin from manifest…**
4. Select `manifest.json` from this folder
5. The plugin now appears under **Plugins → Development → Bloom**

### Get a Bloom API key

[trybloom.ai/developers](https://www.trybloom.ai/developers)

---

## Project structure

```
src/
  code.ts               Figma plugin sandbox — figma.* API, clientStorage, canvas ops.
                        No DOM. Communicates with the UI only via postMessage.

  ui.html               Plugin iframe markup — pure HTML, no inline script.
                        The webpack bundle is injected and inlined at build time.

  ui/
    client.ts           Bloom REST API client (fetch-based, self-contained).
                        Handles auth, brands, image generation, polling, library, credits.

    state.ts            Shared mutable UI state + low-level helpers:
                        postToCode(), showToast(), getApiKey(), getBrandSessionId().

    render.ts           Pure DOM rendering helpers — reads state, writes DOM.
                        renderVariants, renderRatios, renderFramePill, showResults,
                        renderLibraryGrid, syncXxx, flashInsertButton, etc.

    app.ts              View controller and application bootstrap.
                        showView(), generation/edit/batch flows, brand picker,
                        library pagination, zoom overlay, postMessage handler,
                        event wiring, and init().

  ui-styles.ts          Webpack UI entry point — imports ui.css and calls init().
  ui.css                All plugin styles (design tokens, layout, components).

  bloom-client.ts       Typed Bloom API client for external use (not bundled into UI).
                        Kept in sync with ui/client.ts. Imports from bloom-api-schema.ts.

  bloom-api-schema.ts   TypeScript interfaces for every Bloom OpenAPI 3.1.1 shape.
                        Used by bloom-client.ts and as the authoritative type reference.

manifest.json           Plugin name, main/ui entry points, and network allowlist.
webpack.config.js       Bundles code.ts → dist/code.js and ui-styles.ts → dist/ui.html
                        (styles + JS inlined by HtmlWebpackPlugin + HtmlInlineScriptPlugin).
tsconfig.json           TypeScript config (target ES6, strict: true).
```

---

## Architecture

Figma plugins run in two separate sandboxes that can only communicate via `postMessage`:

| Sandbox | File | Can use |
|---|---|---|
| Plugin main thread | `src/code.ts` | `figma.*`, `fetch()` to allowlisted hosts |
| UI iframe | `src/ui/` | DOM, `fetch()` to any host, Web APIs |

- **`code.ts`** handles all canvas and storage operations: inserting/replacing images, reading selections, persisting the API key and brand ID via `figma.clientStorage`.
- **`src/ui/`** handles all Bloom API calls (`/brands`, `/images/generations`, `/images/{id}/edit`, `/credits`) and drives the plugin's five views.
- Image bytes are fetched by `code.ts` (to bypass iframe CORS restrictions) and forwarded to the UI as base64 data URLs via `IMAGE_DATA_RESULT`.

---

## Plugin ID (required before publishing)

`manifest.json` intentionally omits the `id` field so each team owns their own Figma plugin identity. You can develop and import the plugin locally without an `id`.

When you are ready to publish to the Figma Community:

1. In Figma Desktop: **Plugins → Development → New plugin…**
2. Copy the numeric `id` Figma assigns
3. Add it to `manifest.json`:

```json
{
  "name": "Bloom – On-Brand Image Generator",
  "id": "YOUR_FIGMA_PLUGIN_ID",
  ...
}
```

Never reuse another team's plugin ID — Figma uses `id` to route updates to the correct listing.

---

## License

MIT — see [LICENSE](LICENSE).
