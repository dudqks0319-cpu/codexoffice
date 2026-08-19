# Microsoft Office manual compatibility gate

Status: **HOLD — Excel 16.105.3 and PowerPoint 16.105.1 are installed, but Word
is missing and no complete source-bound manual packet exists.** On source
`da55e787d13eed00412a43a75d5b523a092e2776`, Excel preserved three worksheets,
three valid frozen panes, two charts, six conditional-formatting regions, and
the edited value, formula, and chart title after an Office save and reopen.
PowerPoint preserved five slides, one master, eleven layouts, and one media
part after an Office title edit, shape move, save, and reopen. These are useful
partial observations, but they are not release evidence because the required
screenshots, Word flow, and complete bidirectional CodexOffice packet are
missing.
Do not close or force-quit an existing Office process because it may contain
unrelated unsaved user work. This document defines the manual release gate; it
does not convert LibreOffice or Electron automation into Microsoft Office
evidence.

Before producing the source-bound candidate, run
`npm run release:preflight`. The canonical `npm run release:mac:package`
command enforces the same checks before packaging and refuses vulnerable
dependencies, dirty or mismatched source, missing Microsoft Office or
LibreOffice evidence, missing signing/notarization prerequisites, an unverified
update exercise, and missing AI provider operations evidence.

## Evidence header

Record these values before testing:

- CodexOffice source SHA and packaged artifact SHA-256
- macOS version and hardware architecture
- Word, Excel, and PowerPoint full version/build numbers
- tester name and test date
- one evidence directory named with the CodexOffice version and source SHA

Copy every fixture into that evidence directory. Never edit the tracked corpus
in place. Capture a screenshot before editing, after Office opens the saved
file, and after the Office-authored file reopens in CodexOffice.

Copy `docs/microsoft-office-evidence.example.json` into the same evidence
directory as `microsoft-office.json`, replace every placeholder, and calculate
SHA-256 for the exact release artifact, fixture copies, Office-saved documents,
and screenshots. Verify the completed packet with:

```sh
GENOFFICE_SOURCE_SHA=<exact-40-character-release-SHA> \
  npm run verify:office-evidence -- /absolute/path/to/microsoft-office.json
```

The schema-v2 verifier requires fresh evidence from the previous 30 days and
the tested architecture. It rejects unknown fields, absolute/traversing paths,
symlinks, empty or oversized files, duplicate paths, digest mismatches,
unchanged fixture/output bytes, incomplete versions/screenshots, and unchecked
manual assertions. It verifies release ZIP, OOXML ZIP, and PNG/JPEG signatures
instead of trusting file extensions. The release input must contain
exactly one bounded Codexoffice `release-identity.json`; its source SHA, app
identity, and package payload metadata must match the candidate. The ZIP central
directory, identity, and `app.asar` have independent entry/count/size limits;
the actual archived `app.asar` SHA-256 must match the receipt. The release file
is parsed and hashed through one no-follow descriptor so a pathname swap cannot
change the candidate mid-check. Other files are hashed in bounded chunks. The
verifier proves packet integrity and completeness; it does not replace the human
visual judgment described below.

After Excel and PowerPoint save their disposable fixture copies, reopen both
Office-authored outputs in isolated CodexOffice profiles and capture only the
Electron application pages with the explicit manual-QA lane:

```sh
GENOFFICE_OFFICE_EXCEL_OUTPUT=/absolute/path/to/excel-roundtrip.xlsx \
GENOFFICE_OFFICE_POWERPOINT_OUTPUT=/absolute/path/to/powerpoint-roundtrip.pptx \
GENOFFICE_OFFICE_REOPEN_EVIDENCE=/absolute/path/to/evidence/reopen \
GENOFFICE_OFFICE_EXCEL_MARKER=unique-excel-marker \
GENOFFICE_OFFICE_POWERPOINT_MARKER=unique-powerpoint-marker \
  npm run test:e2e:office-reopen
```

This lane refuses relative paths and missing markers, uses a scratch
CodexOffice profile, and captures only the editor page rather than the desktop.
Its screenshots cover the CodexOffice reopen side only; the separate Microsoft
Office screenshots and human assertions below remain mandatory.

## Word round trip

Fixture: `apps/docs/tests/pagination-corpus/docx/06-with-footnotes.docx`

1. Open the copy in CodexOffice and confirm 20 footnote references render.
2. Edit the first footnote with a unique marker, save, close, and reopen it in
   CodexOffice.
3. Open that saved file in Word. Confirm the marker, all 20 references, the
   untouched second footnote, page breaks, fonts, images, headers, and footers.
4. In Word, edit one body paragraph and the second footnote, save, close, and
   reopen the result in CodexOffice.
5. Confirm both Word edits remain, the first marker remains, and no protected
   block or unrelated content disappeared.

PASS requires no repair prompt, data-loss warning, shifted reference target, or
unexpected pagination break attributable to the round trip.

## Excel round trip

Fixture: `qa-artifacts/model-comparison/sol-high/sol-high-portfolio.xlsx`

Do not substitute the Luna Max comparison workbook for this gate. Its worksheet
panes use namespaced `x:xSplit`/`x:ySplit` attributes, and Microsoft Excel
normalizes them away. The Sol High workbook contains valid unprefixed pane
attributes and is the representative frozen-pane preservation fixture. The
Luna workbook remains a negative interoperability case, not a PASS corpus.

1. Open the copy in CodexOffice and record sheet names, used ranges, formulas,
   displayed values, tables, images, and the two chart titles/series.
2. Change one ordinary value and one formula, save, close, and reopen it in
   CodexOffice.
3. Open the saved file in Excel. Force calculation and confirm formulas,
   displayed values, number formats, conditional formats, frozen panes, sheet
   visibility/order, charts, and images.
4. In Excel, change one formula and one chart title, save, close, and reopen the
   result in CodexOffice.
5. Confirm the Excel-authored changes and every unrelated sheet/chart remain.

PASS requires no repair dialog, removed external part, formula downgrade,
chart-series loss, or visible style regression in the selected corpus.

## PowerPoint round trip

Fixture: `packages/pptx-engine/tests/fixtures/01_standard_business.pptx`

1. Open the copy in CodexOffice and record slide count, master/layout count,
   fonts, theme colors, backgrounds, images, and speaker notes.
2. Apply the Graphite design, edit one text element, save, close, and reopen it
   in CodexOffice.
3. Open the saved file in PowerPoint. Confirm slide size/count, master/layout
   relationships, theme colors/fonts, text wrapping, images, charts, notes, and
   animations/transitions that existed before the edit.
4. In PowerPoint, edit one title and move one shape, save, close, and reopen the
   result in CodexOffice.
5. Confirm both PowerPoint edits remain and no unrelated slide, relationship,
   media part, or theme-override content disappeared.

PASS requires no repair prompt, substituted master/layout, missing font/theme
slot, clipped text, or media/relationship loss.

## Release decision

- `PASS`: all three applications complete both directions with the required
  screenshots, exact version/build numbers, and fixture hashes.
- `HOLD`: an Office application, exact release artifact, or required evidence
  is missing.
- `FAIL`: Office repairs the file, content changes unexpectedly, or a saved
  Office-authored file cannot reopen in CodexOffice.

For final packaging, set
`GENOFFICE_MICROSOFT_OFFICE_EVIDENCE=/absolute/path/to/microsoft-office.json`.
The canonical release preflight reports only generic PASS/HOLD/FAIL text and
never prints the evidence path or verifier details.
