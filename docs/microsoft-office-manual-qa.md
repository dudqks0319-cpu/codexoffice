# Microsoft Office manual compatibility gate

Status: **HOLD — Microsoft Word, Excel, and PowerPoint are not installed on the
current verification Mac.** This document defines the manual release gate; it
does not convert LibreOffice or Electron automation into Microsoft Office
evidence.

Before producing the source-bound candidate, run
`npm run release:preflight`. The canonical `npm run release:mac:package`
command enforces the same checks before packaging and refuses vulnerable
dependencies, dirty or mismatched source, missing signing/notarization
prerequisites, and a missing or unsafe update channel.

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

The verifier rejects absolute/traversing paths, symlinks, missing files,
digest mismatches, incomplete application versions/screenshots, and unchecked
manual assertions. It proves packet integrity and completeness; it does not
replace the human visual judgment described below.

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

Fixture: `qa-artifacts/model-comparison/luna-max/luna-max-portfolio.xlsx`

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
