# Architecture

OrangeAssistant is a small Electron application with three layers.

## 1. Main process (`main.js`)

- Creates the frameless window and owns window controls.
- Exposes a small IPC surface for books, PDF bytes, threads, settings and memos.
- Reads the copied PDF from the application data directory and sends it to the renderer as a `Uint8Array`; the renderer never receives arbitrary filesystem paths.
- Keeps the AI API key in main-process settings and performs all model requests with `fetch`.

Supporting modules:

- `src/main/store.js` — local library, settings, conversations and memo persistence.
- `src/main/pdf.js` — text extraction with PDF.js and coordinate-preserving line data.
- `src/main/segment.js` — conservative chapter-only segmentation.
- `src/main/ai.js` — OpenAI-compatible chat requests, local fallback, image requests and context construction.

## 2. Preload (`preload.js`)

`contextBridge` exposes a narrow `window.orange` API. Renderer code cannot require Electron, Node or the filesystem directly. The window uses context isolation and no Node integration.

## 3. Renderer (`src/`)

- `index.html` — shell, titlebar, library, reader, chat panel, modals.
- `app.js` — application state and rendering:
  - PDF.js document loading, page placeholders and lazy canvas/text-layer rendering.
  - Text selection tooltip and screenshot cropping from rendered page canvases.
  - Chat streaming, history, copy and new-chat actions.
  - Memo library, categories, editing and deletion.
- `markdown.js` — escaped Markdown rendering with KaTeX and a readable plain-text fallback.
- `styles.css` — warm theme, dark theme, PDF reader, DeepSeek-style conversation and memo UI.
- `src/vendor/` — browser builds of PDF.js and KaTeX, including their upstream licenses.

## PDF pipeline

1. User imports a PDF; main copies it into the book directory.
2. `pdf.js` extracts positioned text lines.
3. `segment.js` detects chapter headings and stores chapter title, page, page range and a bounded text preview.
4. The renderer receives the original PDF bytes and renders pages with PDF.js.
5. Pages are rendered lazily with an `IntersectionObserver`; only visible/nearby pages get a canvas and text layer.
6. The text layer stays transparent over the canvas, enabling native text selection without changing the visual document.

Chapter detection intentionally does **not** create knowledge points or examples. It is conservative: if no reliable headings exist, the document is split into a small number of page/content chunks.

## Data model

Application data lives in `%APPDATA%\OrangeAssistant`.

```text
settings.json
memos.json
library/
  index.json
  <book-id>/
    book.json
    source.pdf
```

`book.json` contains book metadata, chapters, conversations (`threads`) and messages. Memos are global rather than per-book and store a source book/page when available.

## AI flow

- The renderer creates a thread with an anchor: a chapter or page, a text selection, or a screenshot.
- Main builds a bounded context from the chapter preview, selected text and screenshot-region text.
- The current user message is sent as plain text, or as a multimodal `image_url` message for screenshots.
- If the provider rejects images, main retries once with the extracted region text and a short note.
- API keys and requests are never handled in renderer JavaScript.

## Security boundaries

- No `nodeIntegration` in the renderer.
- IPC inputs are validated and strings are length-limited.
- PDF.js runs with `isEvalSupported: false`.
- The Content-Security-Policy only allows local scripts, styles, images and workers.
- Screenshot data is stored as a data URL in the thread anchor; memo content is plain text and escaped when rendered.

## Testing and CI

`npm run check` is dependency-free: syntax checks, required assets, JSON validation and a small secret scan. GitHub Actions runs it on Windows, then builds an unpacked directory to validate packaging. Tagged releases build an unsigned NSIS installer.
