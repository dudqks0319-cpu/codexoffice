# LibreOffice manual compatibility gate

Status: **HOLD — automated structural round-trip is 3/3 PASS, but the current
environment exposes only the LibreOfficeDev 26.8 command-line runtime and no
source-bound visual/manual evidence packet.** CLI conversion does not prove
layout, editability, or user-visible fidelity.

Use copies of the same tracked corpus used by `npm run compat:libreoffice`:

| App surface | Fixture                                                          | Automated result                               | Manual result |
| ----------- | ---------------------------------------------------------------- | ---------------------------------------------- | ------------- |
| Docs        | `apps/docs/tests/pagination-corpus/docx/06-with-footnotes.docx`  | 20 body references and 22 footnotes preserved  | HOLD          |
| Sheets      | `qa-artifacts/model-comparison/luna-max/luna-max-portfolio.xlsx` | 3 sheets, 3 worksheets, and 2 charts preserved | HOLD          |
| Slides      | `packages/pptx-engine/tests/fixtures/01_standard_business.pptx`  | 5 slides, 1 master, and 1 media part preserved | HOLD          |

For each copied fixture:

1. Open it in CodexOffice, make one ordinary edit, save, close, and reopen.
2. Open the result in a stable LibreOffice desktop release and capture the
   before/after application version, full window, and edited region.
3. Confirm text wrapping, fonts, page/sheet/slide structure, formulas, charts,
   images, notes, and protected content relevant to that fixture.
4. Make one LibreOffice-authored edit, save, close, and reopen in CodexOffice.
5. Record PASS/FAIL, the exact visible difference, user impact, and a safe
   workaround. Never replace a tracked fixture in place.

PASS requires all three bidirectional flows with screenshots and exact artifact
hashes. A repair prompt, missing relationship/media, changed formula, shifted
footnote, clipped text, or layout regression is FAIL. Missing desktop runtime,
screenshots, hashes, or human review remains HOLD.
