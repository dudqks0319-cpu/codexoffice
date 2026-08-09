# GenOffice macOS package release state

Last verified: 2026-08-10 (Asia/Seoul)

## Source and build

- Branch: `agent/codex-sdk`
- Baseline pushed commit: `e1dcd1a feat: add GPT-5.6 model controls and macOS QA evidence`
- Trust-workflow implementation commit: `ef2e810 feat: add review-first AI trust workflows`
- Codex SDK transition commit in history: `69bfc5a feat: replace Genspark AI with Codex SDK`
- Codex SDK package: `@openai/codex-sdk@0.146.0`
- Build commands: `npm run build:all`, then
  `GENOFFICE_LOCAL_UNTIMESTAMPED_SIGN=1 CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac -w @genoffice/shell`
- Build result: PASS (docs, sheets, slides, PDF, shell bundles; arm64 package)

Artifacts:

| Artifact                                               | SHA-256                                                            |              Size |
| ------------------------------------------------------ | ------------------------------------------------------------------ | ----------------: |
| `apps/shell/release-final/Codexoffice-0.5.0-arm64.dmg` | `629e24618addc04ebad2d62a6dd0e64ad1f5fc0eef4e7720051c64ae594e2523` | 296,365,003 bytes |
| `apps/shell/release-final/Codexoffice-0.5.0-arm64.zip` | `0feb0bc9bd045c0344624c1fc82c5ff8b9111c4a43a052b3c7cab9f7bd5c0a98` | 263,678,441 bytes |

- Developer ID identity: `Developer ID Application: Youngbeen Jung (3FG9QJC8WC)`
- `codesign --verify --deep --strict`: PASS for the isolated signed staging app,
  ZIP extraction, and DMG-mounted app.
- The local fallback copies the builder output into an isolated staging area,
  applies one final Developer ID signature, creates ZIP/DMG artifacts with
  macOS system tools, then reopens and verifies both artifacts. It deliberately
  does not satisfy the secure
  timestamp/notarization distribution gate.
- `spctl --assess`: HOLD — `source=Unnotarized Developer ID` for this local,
  untimestamped candidate.

## Packaged smoke result

Driver: `node scripts/drivers/driver.packaged-smoke.mjs`

| Surface                           | Result                | Evidence                                                                      |
| --------------------------------- | --------------------- | ----------------------------------------------------------------------------- |
| Home                              | PASS                  | Hero visible, 4 quick cards                                                   |
| Codex login                       | BLOCKED-EXTERNAL-AUTH | Login attempted; UI remained `Waiting… / Codex account for this app`          |
| Docs text edit                    | PASS                  | One contenteditable editor; `Codexoffice packaged text smoke` inserted        |
| Sheets Codex model settings       | PASS                  | `gpt-5.6-luna` + `max` saved and restored after reload                        |
| Sheets deterministic QA v1        | PASS                  | Visible `C3: #REF!` detected as one critical finding with remediation actions |
| Slides canvas/AI surface          | PASS                  | AI input present; one blank 1280×720 slide returned                           |
| Slides image generation/insertion | BLOCKED-EXTERNAL-AUTH | Not invoked because the packaged smoke account was not signed in              |

The packaged settings file was written atomically with mode `0600` and contained only the Codex model override; no API key was persisted.

### Isolated authenticated image smoke

An existing Codex login was copied into a mode-`0700` temporary profile with
`auth.json` mode `0600`; its contents were never printed or committed. The
normal per-call usage/cost dialog remains enabled. Automation can bypass it only
when all three explicit smoke flags are set and `GENOFFICE_USER_DATA` resolves
under the operating-system temporary directory.

- Login: PASS.
- Codex image generation: PASS — PNG, 1536×1024.
- Native slide insertion: PASS — one generated `picture` node,
  `sourceId=picnew_1_msm1515y`.
- Provider `savedPath` is treated only as bounded metadata. The app never reads,
  deletes, retains, or trusts that provider-managed path; bounded base64 bytes,
  magic, MIME, and dimensions are authoritative.
- Evidence: `authenticated-image-smoke.json`,
  `07-authenticated-before-image.png`, and
  `08-authenticated-image-inserted.png`.

## Authenticated GPT-5.6 package smoke

The normal packaged app profile was signed in with a ChatGPT Codex account. The
Codex app-server `model/list` response was rendered in the Sheets settings UI.

- Visible models: `gpt-5.6-sol` (default), `gpt-5.6-terra`, `gpt-5.6-luna`,
  `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.3-codex-spark`.
- `gpt-5.6-terra`: PASS — generated and saved a 6-row project status workbook
  with three formulas, conditional formatting on `D2:D7`, and frozen header
  row.
- `gpt-5.6-sol`: PASS — generated and saved a five-slide Korean presentation
  with cover, problem, solution, 90-day plan, and KPI sections.
- The model switch was verified in both the selected UI radio state and the
  persisted non-sensitive `ai-settings.json` value.
- A first Terra formatting proposal exposed that Univer's facade rejected
  right alignment. The app now writes the complete `HorizontalAlign` enum
  through the underlying style patch; two regression tests cover right and
  cleared alignment.

Generated smoke artifacts:

| Artifact                                                         | SHA-256                                                            |         Size |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ | -----------: |
| `qa-artifacts/gpt-5.6-smoke/gpt-5.6-terra-project-status.xlsx`   | `79a18cc071382e342f4f9dd2d1732c7bbbfeec58a13d1b2f1f4b27a1ab3ff850` |  3,822 bytes |
| `qa-artifacts/gpt-5.6-smoke/gpt-5.6-sol-ai-automation-plan.pptx` | `cb773099e609077f4ca5923ec7ec26d1ba14d42e3df9721cca39b4f01f264836` | 12,929 bytes |

Both Office files passed ZIP integrity checks and independent `openpyxl` /
`python-pptx` parsing.

## Authenticated Luna xhigh complex workbook and deck smoke

The packaged settings UI selected `gpt-5.6-luna` with the highest reasoning
effort exposed by `@openai/codex-sdk@0.146.0`, `xhigh`. The persisted settings
file remained mode `0600`, stored no API key, and restored both model and
reasoning effort.

- Excel: PASS — 3 sheets (`Portfolio`, `Scenarios`, `Dashboard`), 120 formulas,
  56 cross-sheet formulas, conditional formatting, and frozen panes. Independent
  recomputation confirmed total investment ₩1,152M, expected ARR ₩1,175.85M,
  Base value ₩23.85M, Downside −₩618.12M, and Upside ₩608.22M.
- Slides: PASS — the workbook was attached through the packaged Slides AI
  surface and Luna/xhigh generated exactly 3 slides with 29 shapes and one chart.
  `python-pptx` independently confirmed the slide count and the workbook-derived
  decision values.
- Runtime fix: complex xhigh turns were silent for longer than the former
  300-second idle limit. The bounded xhigh limits are now 600 seconds idle,
  630 seconds renderer IPC silence, and 900 seconds absolute turn duration.

Generated artifacts:

| Artifact                                                                             | SHA-256                                                            |         Size |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | -----------: |
| `qa-artifacts/gpt-5.6-luna-xhigh-smoke/gpt-5.6-luna-xhigh-saas-portfolio.xlsx`       | `a67145e757e2af27ccc83d61754fd82adc460490f6dcf652e20d2b7d71415664` |  9,685 bytes |
| `qa-artifacts/gpt-5.6-luna-xhigh-smoke/gpt-5.6-luna-xhigh-investment-committee.pptx` | `429bedd0828ae17b14c1db5650a779c0dc2268b58d8b59ac6fd08d48e9840ed7` | 12,306 bytes |

## Max reasoning support and Sol/high vs Luna/max comparison

The app now exposes `max` in settings, persistence, IPC validation, provider
types, and the SDK/CLI request path. The pinned SDK 0.146.0 declaration stops at
`xhigh`, but the runtime passes reasoning effort through verbatim; the
compatibility cast is isolated at the SDK boundary. Bounded `max` limits are 900
seconds stream idle, 930 seconds renderer silence, and 1,200 seconds absolute
turn duration. The packaged `app.asar` contains the six-value reasoning enum.

An identical workbook-and-deck task was sent to `gpt-5.6-sol/high` and
`gpt-5.6-luna/max` using isolated output directories because this Mac could not
start another Electron process. Independent results:

- Sol/high: artifact-ready in 13m45s; workbook PASS (3 sheets, 135 formulas,
  66 cross-sheet formulas, frozen panes on all sheets); 3-slide deck visually
  PASS, but each slide is a single bitmap and therefore not directly editable.
- Luna/max: artifact-ready in 18m29s; core numbers and 3-sheet structure PASS,
  but all frozen panes were omitted; 3-slide deck PASS with 89 editable shapes
  and one chart. The agent remained running after artifacts were complete and
  was stopped at 25m34s.
- Both independently recomputed to investment ₩1,152.00M, expected ARR
  ₩1,175.85M, Base ₩23.85M, Downside −₩618.12M, and Upside ₩608.22M.

Evidence: `qa-artifacts/model-comparison/comparison-report.md` and
`qa-artifacts/model-comparison/independent-verification.json`.

## Luna/max review-first evidence deck package smoke

The independently extracted packaged app used an isolated authenticated profile
and persisted `gpt-5.6-luna` with `max` reasoning. A complex executive decision
deck was generated and then evidence-linked in page-scoped review batches to
keep every paid turn bounded.

- Structure: PASS — exactly three pages titled `Summary`, `Analysis`, and
  `Risks / Next Actions`.
- Native editing: PASS — 6, 4, and 3 editable native objects respectively;
  shapes, text, and tables remain editable.
- Review/apply: PASS — structure and every page evidence operation reached
  `REVIEW_READY`, was visually inspected, and then reached `COMMITTED`.
- Evidence gate: PASS — every page had trusted official-source notes and
  `verify_evidence_deck` passed before save.
- Runtime fix: the Slides standalone handler now selects the same bounded
  reasoning-aware absolute timeout as Docs/Sheets (`max`: 1,200 seconds).
- Screenshots: `09-luna-max-running.png`,
  `10a-luna-max-structure-review.png`, `10-luna-max-review-ready.png`,
  `10b-luna-max-page-2-review.png`, `10c-luna-max-page-3-review.png`, and
  `11-luna-max-slide-{1,2,3}.png`.

The first automation copied the model-written draft before its streaming ZIP
writer had closed, so that incomplete copy was excluded instead of being
reported as a PPTX. Repeating the paid model run was not authorized. The
committed screenshots and `luna-max-evidence-smoke.json` are the model-run
evidence; `luna-max-evidence-deck-reconstructed.pptx` is a clearly labelled,
offline native-editable reproduction, not the original model byte stream. The
reproduction is 114,322 bytes, SHA-256
`f42161173ad1a83c369265026b894215b9647b6558533f69d475ee674d88c275`,
passes ZIP integrity, and reopens in `@genoffice/pptx-engine` as exactly three
slides with 28 package entries. The driver now waits for both the visible Saved
status and a stable ZIP end-of-central-directory record before copying future
runs.

## Verification

- `npm run format:check`: PASS
- `npm run lint`: PASS, 0 errors / 8 existing React hook warnings
- `npm run typecheck`: PASS
- `npm test`: PASS, 3,678 passed / 2 skipped
- Rust sidecar: PASS, 53 passed
- `npm run build:all`: PASS
- `npm audit --omit=dev`: HOLD, 47 high vulnerabilities remain in existing dependencies (`js-yaml`, `nanoid` through Univer, and `pdfjs-dist`)
- Final package build, ZIP extraction, DMG mount, and independent
  `codesign --verify --deep --strict` checks: PASS.

## Remaining distribution gates

1. Release owner: complete Apple notarization and staple/notarization verification before distributing the DMG.
2. Release owner: configure `GENOFFICE_UPDATE_URL` and verify the generated `app-update.yml` plus a real update-channel artifact.
3. Dependency owner: triage/fix or formally accept the 47 high audit findings, especially the PDF.js malicious-document execution path and the Univer dependency chain.
4. Operations owner: configure provider-side usage alerts/budget caps and verify
   production cost attribution before enabling image generation broadly; the
   isolated one-shot package smoke proves function, not deployed spend control.

## Reproduction

```sh
cd /Users/jyb-m3max/Desktop/codex/genoffice
CSC_IDENTITY_AUTO_DISCOVERY=false GENOFFICE_LOCAL_UNTIMESTAMPED_SIGN=1 npm run dist:mac
node scripts/drivers/driver.packaged-smoke.mjs
node scripts/drivers/driver.codex-model-list.mjs
GENOFFICE_PACKAGED_APP=/path/to/Codexoffice.app \
  GENOFFICE_CODEX_AUTH_SOURCE=/path/to/isolated/codex-home \
  node scripts/drivers/driver.authenticated-image-smoke.mjs
node scripts/drivers/driver.rebuild-luna-max-deck.mjs
```

The smoke driver uses an isolated temporary HOME/user-data directory, so authentication must be completed explicitly during the run and is not inferred from a developer profile.
