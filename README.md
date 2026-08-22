# Codexoffice

An AI-native office suite for macOS and Windows: word processor, spreadsheet,
presentations, and PDF — five Electron apps sharing one engine layer, built
around AI editing as a first-class workflow rather than a bolted-on chat box.

Codexoffice uses the official OpenAI Codex SDK for its built-in assistant.
It is an independent open-source project, not an OpenAI product or affiliated
publisher. It is a development project: there are no signed installers yet.

## Apps

| App           | Product                | What it is                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/docs`   | **Codexoffice Docs**   | `.docx` word processor. Byte-preserving round trip: only dirty paragraphs are regenerated (paragraph patch), everything else in the original file is kept byte-for-byte, so opening and saving never breaks layout in Word. Paginated view whose line metrics reproduce the original document's layout, tracked changes, comments, styles, equations, ink. |
| `apps/sheets` | **Codexoffice Sheets** | `.xlsx` spreadsheet. UI built on the open-source [Univer](https://github.com/dream-num/univer) core (Apache-2.0) with a large layer of in-house extensions; xlsx import/export runs through an in-house Rust sidecar (calamine + IronCalc), charts are rendered in-house (Konva), plus pivot tables, slicers, conditional formatting, and formula tracing. |
| `apps/slides` | **Codexoffice Slides** | `.pptx` presentations. In-house pptx parse/render/edit engine with masters, charts, cropping, ink, and text shaping (HarfBuzz metrics).                                                                                                                                                                                                                    |
| `apps/pdf`    | **Codexoffice PDF**    | PDF viewer/editor on pdf.js + pdf-lib: annotations, forms, outlines, stamps, signatures, page operations, print.                                                                                                                                                                                                                                           |
| `apps/shell`  | **Codexoffice**        | The suite shell: home screen, tabbed hosting of the four editors, auto-update.                                                                                                                                                                                                                                                                             |

Every app embeds the same AI panel: block-granular AI editing with version
snapshots and diffs in docs, a tool-calling agent over workbook/slide/PDF
state in the others.

**AI provider.** The desktop main process uses `@openai/codex-sdk` with an
app-private Codex authentication directory. Authentication data and child
processes are never exposed to renderer code, and signing out of the app does
not sign out the user's standalone Codex CLI. The existing app tool loop remains
the only component allowed to edit documents.

## Engine packages

All pure TypeScript, no Electron dependency, unit-tested (except the UI kit):

- `packages/docx-engine` — docx parsing → block tree (with `docxIndex`
  anchors and passthrough), OOXML fragment generation, byte-level paragraph
  patching.
- `packages/pptx-engine` / `packages/pptx-render` — pptx model and rendering.
- `packages/file-parse` — text extraction for AI attachments (office formats,
  text formats).
- `packages/agent-core` — the AI agent loop and skill composition shared by
  every app.
- `packages/ai-provider` — provider abstraction and streaming for the model
  backends.
- `packages/ai-search` — Serper web/image search with a DuckDuckGo fallback.
- `packages/i18n`, `packages/ui`, `packages/project-store`,
  `packages/electron-utils` — shared i18n core, React UI kit, recent-files
  store, and Electron main-process helpers.

## Development

```bash
npm ci
npm run fixtures     # generate test .docx fixtures
npm test             # engine + app unit tests (docs/sheets/slides need no display)
npm run typecheck    # tsc --noEmit across every workspace
npm run dev          # all four editors + shell against Vite dev servers
npm run dev:docs     # a single app (same pattern works per workspace)
npm run dist:mac     # package macOS dmg (regenerates third-party notices)
npm run dist:win     # package Windows nsis installer
```

Because npm installs a host-specific Codex runtime, create each installer on
the matching OS and CPU architecture; cross-platform and universal packaging
fail closed instead of embedding the wrong executable.
The aggregate Shell and the supported standalone Docs/Slides installers all
copy the exact-version native Codex vendor directory outside ASAR and configure
the same trusted runtime path.

The sheets app additionally needs a Rust toolchain for its xlsx sidecar
(`cargo` on PATH); `npm run build -w @genoffice/sheets` compiles it
automatically.

### Codex integration and safety boundary

- The Codex SDK and native CLI are pinned to `0.146.0` in the lockfile.
- Sign in from the app's account menu. The bundled native CLI stores its auth
  under the app's user-data directory, isolated from standalone Codex settings,
  hooks, plugins, rules, memories, and sessions.
- Model turns run in a temporary empty working directory with a read-only
  sandbox, approvals disabled, model-controlled arbitrary network/web tools
  disabled, and no configured MCP servers. Provider egress required by Codex
  remains available. Codex returns a strict text/tool-call envelope; Codexoffice's
  existing allowlisted tools perform the requested office edits.
- Renderer requests and model tool inputs are runtime-validated. The main
  process rejects duplicate IDs, bounds request and response sizes, limits
  concurrent/burst/hourly/daily use, caps the daily requested-token budget,
  and aborts every turn at an absolute 180-second deadline. These limits are
  intentionally in-process; restarting the app resets them.
- Base64 image inputs are type/size/count bounded, staged as mode `0600`
  temporary files, and deleted after each turn.
- Search has independent query/result/body/concurrency/rate limits. Remote
  images are fetched with per-hop public-address validation, DNS pinning,
  redirect revalidation, byte/time/concurrency limits, and MIME/signature
  checks.
- Emergency kill switches are available to a trusted launch environment:
  `GENOFFICE_AI_DISABLED=1`, `GENOFFICE_SEARCH_DISABLED=1`, and
  `GENOFFICE_REMOTE_IMAGE_DISABLED=1`.
- Codex image generation is available in Slides through a separate App Server
  path. It is fail-closed by default; a trusted launch environment must set
  `GENOFFICE_CODEX_IMAGE_GENERATION=1`. Every generation shows a usage/cost
  confirmation with Cancel selected by default, then enforces account
  capability checks, replay protection, quotas, cancellation, an absolute
  timeout, one-image output, bounded PNG/JPEG/WebP validation, and a full native
  decode/re-encode step before PPTX insertion.
  The generated bitmap is inserted in the main process. Codex credentials and
  the raw generation response never enter the renderer; the renderer receives
  the ordinary bounded `RenderSlide` needed to display the image, while the
  model tool result receives insertion metadata only.
- The packaged Electron app copies the platform Codex runtime outside ASAR.
  A release smoke test must still prove the packaged executable can authenticate
  and complete a turn on each target OS/architecture.
- Optional search uses `SERPER_API_KEY` in the main process. Without it, search
  falls back to DuckDuckGo. Codex has provider egress, but no model-controlled
  arbitrary network or web tool in this app-private runtime.
- Before a public release, configure and observe provider/account-side budget
  caps and alerts. Local in-process guards cannot enforce an account-wide
  ceiling or survive a deliberate app restart.

Codex can build a complete presentation locally with the existing native slide
tools, analyze bounded image attachments, and generate an original image for a
slide. Capabilities that still require a separate OpenAI Platform API service
or a provider-specific converter remain intentionally unavailable: audio/video
analysis and transcription, hosted whole-page regeneration, and PDF-to-Word
cloud conversion. Codex account authentication is not reused as a Platform API
key, and arbitrary local skills/plugins are not enabled inside the app-private
runtime.

Local UI/e2e driver scripts (Playwright + Electron, for local acceptance, not
committed by default) live in [`scripts/drivers/`](scripts/drivers/README.md).

## Architecture notes (docx round trip)

```
open docx ─► archive original by hash (never touched)
          ─► docx-engine parses word/document.xml top-level elements (w:p / w:tbl / …)
          ─► Block tree, each block anchored by docxIndex + original XML slice
          ─► TipTap streaming editor (manual + AI editing, dirty tracking)
save      ─► dirty blocks → OOXML fragments (referencing existing styles only)
          ─► splice into original document.xml (untouched blocks keep original bytes)
          ─► repack zip; all other entries copied byte-for-byte
```

The same philosophy holds in sheets and slides: the original file is the
source of truth, edits are applied as narrow patches, and everything the
editor didn't touch survives the round trip untouched.

## Security

See [SECURITY.md](SECURITY.md) for the process security posture (renderer
sandboxing, IPC validation, external-link gating) and the threat models for
AI-generated content.

## Third-party notices

`npm run notices` regenerates the bundled third-party license summary
(`tools/gen-third-party-notices.mjs`); all runtime dependencies are
MIT/Apache-2.0/OFL, and the bundled fonts (Liberation, Carlito, Caladea, Noto
CJK subsets) are OFL/Apache.

## License

Codexoffice is licensed under the [Apache License 2.0](LICENSE), with one
exception: the `ee/` directory is reserved for future enterprise modules and
is covered by the inherited enterprise license in [`ee/LICENSE`](ee/LICENSE).
Legacy `@genoffice/*` package scopes and environment-variable names remain as
source-compatibility identifiers; they are not the product name.
