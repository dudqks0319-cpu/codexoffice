# Architecture

## Trust boundaries

```text
Renderer (React spreadsheet shell + Univer)
  -> typed preload bridge
  -> validated Electron IPC
  -> Rust XLSX sidecar
  -> temporary row-chunk index
  -> copy-on-write OOXML gateway

Renderer
  -> context extractor
  -> local privacy policy
  -> cloud planner
  -> untrusted command DSL
  -> local validation and dry-run
  -> user approval
  -> atomic commit and audit
```

The document core is the only workbook writer. The renderer cannot access disk, model credentials, or subprocesses. A cloud model cannot invoke native capabilities or commit files.

The Electron main process owns the XLSX sidecar lifecycle. The renderer receives an opaque session ID and can request only validated, size-limited worksheet ranges. External workbooks are editable: the renderer journals commands against that session, while the main process verifies the original file hash and writes an atomic, preservation-checked XLSX update.

## Renderer composition

React owns the desktop title bar, Ribbon navigation, AI panel, async status, and file metadata. Univer owns the formula bar, worksheet canvas, sheet tabs, selection, scrolling, and zoom controls.

The AI panel is a collapsible peer of the worksheet rather than a permanent overlay. Collapsing it expands the worksheet column without recreating the Univer runtime or workbook session.

## Styles and visual objects

The sidecar resolves `styles.xml` cell formats and carries the source style index with each streamed cell. The renderer converts fonts, fills, alignment, and number formats into Univer cell style data.

Worksheet relationship files locate drawing parts without parsing worksheet bodies. Drawing anchors then resolve chart and image relationships. Charts use their OOXML cached categories and values and render as Apache-licensed Univer floating DOM components; this avoids the license-gated Univer Pro chart package. Embedded image data is loaded only when its anchored object is installed, through a validated 20MB media endpoint. Floating objects are reinstalled for the active sheet and viewport so off-screen drawings do not create an unbounded DOM.

## Large workbook reads

The sidecar reads ZIP metadata, workbook relationships, worksheet dimensions, and shared strings without constructing a JavaScript workbook snapshot. On the first range request for a sheet, it streams worksheet XML once into temporary 256-row chunks. Range requests wait only for the required chunk, and parsing continues in the background.

Univer starts with worksheet dimensions and empty sparse cell data. Scroll and active-sheet events request the visible range plus a buffer. Before another window is installed, the previous range and formats are cleared, so renderer memory does not grow with the total workbook size. Visual discovery reads only relationship, drawing, chart, style, and media metadata parts; it never builds a DOM for a large worksheet.

## Workbook state

Each open external workbook owns:

1. The original XLSX package.
2. A sparse renderer view plus sidecar-backed workbook metadata.
3. A revisioned operation journal.

Small workbooks (up to 50,000 declared cells) preload completely for live formula calculation. Larger workbooks keep the sparse view: a bounded dependency closure is pinned into Univer when possible, with a sidecar calculation fallback when the closure is not representable. The OOXML gateway replays the journal and verifies that every entry outside the declared mutation set survives.

## Adapter boundary

The blank/demo workbook path depends on `WorkbookAdapter`, which exposes:

- `getSnapshot`
- `plan`
- `apply`
- `undo`

Imported XLSX workbooks use a separate lazy state and edit journal because the full file is intentionally absent from renderer memory. Both paths share the same validated command DSL and preview/approval boundary; imported-file AI apply is currently limited to bounded, single-sheet cell proposals so rollback remains atomic.

## XLSX preservation

The gateway and sidecar together:

- validates ZIP path safety and entry count;
- bound renderer IPC ranges and every worksheet part that must be rewritten;
- inventory ZIP entries and preserve untouched compressed payloads through raw copy;
- resolves a worksheet through workbook relationships;
- rewrites only the target worksheet or workbook metadata;
- refuses unknown sheet mappings and stale file hashes;
- verify the original whole-file SHA-256 before saving;
- write through a temporary sibling file and atomic rename.

The current gateway does not claim full OOXML compatibility. Its contract is that only declared entries may change; an unsupported edit or an unexpected package difference fails closed.

## Production gaps

- Excel/LibreOffice qualification corpus with golden visual, formula, no-op, and targeted-edit comparisons.
- Range-move persistence, editing of tables that already exist in a file, and structured-reference formula evaluation.
- Native Excel chart fidelity for themes, secondary axes, trendlines, 3D/effects, and scatter-series range editing.
- Formula-function parity and differential calculation validation beyond the Univer/sidecar fallback coverage.
- Pixel-identical print pagination across fonts and printer drivers.
- Signed/notarized distribution, an exercised update channel, telemetry policy, and enterprise controls.
