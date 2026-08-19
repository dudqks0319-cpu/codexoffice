# GenOffice macOS package release state

Last verified: 2026-08-19 (Asia/Seoul; P0 remote CI plus local P1 PDF lifecycle,
AI operations and updater evidence gates, full repository regression, and
LibreOffice corpus evidence)

## 2026-08-19 source-bound updater evidence gate

- A valid HTTPS channel is no longer sufficient for release readiness. The
  macOS preflight remains HOLD until `GENOFFICE_UPDATE_EVIDENCE` points to a
  fresh packet bound to the exact release source SHA and normalized channel.
- The packet binds the previous and next signed release ZIPs, extracted
  `app-update.yml`, published `latest-mac.yml`, and redacted success/failure
  observations to SHA-256. The verifier independently checks the next ZIP's
  SHA-512 against `latest-mac.yml`, requires a strictly newer stable version,
  and rejects unsafe URLs, unknown fields, stale observations, traversal,
  symlinks, duplicates, oversized files, or incomplete preservation claims.
- The updater now refuses an install action until `update-downloaded` has been
  received for the exact latest offered version, ignores duplicate concurrent
  download actions and stale completion/progress events, and allows retry after
  a rejected download. Unit coverage proves a failed or stale download cannot
  call `quitAndInstall`; the retry path must reach the matching downloaded state
  first.
- This is local implementation and evidence-contract proof only. No update was
  published and no signed N-to-N+1 exercise occurred, so the external update
  gate remains HOLD.
- Fresh regression evidence for this checkpoint: 3,875 JavaScript/TypeScript
  tests passed with two intentional skips; Sheets Rust 53/53 passed; all
  workspace typechecks passed; lint reported zero errors and eight existing
  React Hook warnings; all five production builds passed; Electron E2E passed
  17/17 in the permitted GUI environment; LibreOffice structural round-trip
  passed 3/3; and formatting plus `git diff --check` passed.
- Codex Security diff scan
  `1c924587-1fcf-4fc0-9197-f8266066f407` reviewed all four changed runtime/tool
  surfaces with complete coverage and zero reportable findings. Measured usage
  was 3,204,302 total tokens, 3,197,340 input tokens, and 3,154,560 cached input
  tokens. TAC access was not granted, but that advisory status did not gate the
  local scan.

## 2026-08-19 P1 integration and AI operations gate

- The process-global AI request ledger now uses schema v2. It preserves the
  exact accepted reservation count/token budget and a bounded, redacted audit
  stream containing only timestamps, token reservations, allow/deny decisions,
  and stable reason codes. Prompt text, document content, renderer request IDs,
  account identifiers, and credentials are never persisted. Repeated identical
  denials are coalesced to one record per reason per minute to prevent a blocked
  renderer from turning audit logging into unbounded synchronous disk I/O.
- The macOS release preflight now fails closed without an exact-source AI
  operations packet. The packet must prove a provider-enforced daily/monthly
  cap, an alert at or below 80%, fresh provider and application kill-switch
  exercises, multi-client provider-account aggregation, and a redacted
  cost-attribution log. The verifier rejects stale dates, unknown fields,
  symlinks, traversal, digest drift, individual artifacts above 20 MiB, and a
  packet above 64 MiB. This validates integrity, not provider truth.
- Codex Security diff scan
  `d0bedaae-5376-4e60-ad0b-bcd8291d9c3d` completed with all five changed
  security surfaces covered and zero reportable findings. TAC enrollment was
  not granted, but that status is advisory and did not gate the local review.
- Full fresh integration evidence: 3,863 JavaScript/TypeScript tests passed with
  two intentional skips; Sheets Rust 53/53 passed; all workspace typechecks
  passed; lint reported zero errors and eight pre-existing React Hook warnings;
  all five production builds passed; Electron E2E passed 17/17 in 49.0 seconds;
  formatting and `git diff --check` passed; and LibreOffice structural
  round-trip passed 3/3.
- The first full E2E run exposed a test-only race with the intentionally
  two-second `Saved` toast under continuous process sampling. The test now waits
  for the stable successful state (no pending/error indicator and Save disabled)
  and samples every 25 ms. Focused PDF lifecycle E2E then passed 2/2 and the
  complete suite passed 17/17.
- After committing the checkpoint, exact-source preflight for
  `a46c13ec42a1237f01bf23a112cf13ad3f1ede16` reports dependency, source SHA, and
  clean worktree PASS. Developer ID, notarization, update channel, and provider
  operations evidence remain HOLD. No packaging, signing, provider call, or
  publication was attempted.

## 2026-08-19 PDF P1 lifecycle and commit recovery

This checkpoint is local implementation evidence on branch `agent/codex-sdk`.
It does not claim Microsoft Office, Apple signing/notarization, update-channel,
or provider-account evidence.

- PDF commit journals now use schema v2 and bind the owner PID to an OS process
  generation. A dead owner or a live reused PID with a different generation
  permits the exclusive hard-link repair; the exact active generation and an
  unavailable identity remain fail-closed. Legacy v1 journals still repair
  only when the PID is definitely absent.
- The generation lookup is command-injection resistant: PIDs are positive safe
  integers, macOS uses constant `/bin/ps` argv without a shell, Linux uses
  `/proc/<pid>/stat` plus the boot ID, and Windows uses the fixed system
  PowerShell path with a numeric PID. The current process identity is cached.
- A real Electron stress test performs 20 sequential PDF annotation saves. It
  verifies the hidden sandbox window appears, then each new renderer generation
  disappears; every `genoffice-pdf-job-*` staging root returns to the baseline;
  the source contains 20 square annotations; and final combined working set is
  bounded by both baseline +256 MiB and the fifth save +128 MiB.
- The new actual-timeout E2E exposed and fixed a lifecycle race: when the queue
  deadline elapsed during source staging, `destroy()` could run before the
  hidden window existed and the abandoned async `run()` could create it later.
  `ElectronPdfJobProcess` now records a terminal stop before cleanup and checks
  it after every asynchronous pre-window boundary and immediately after window
  construction. A 1 ms unpackaged-only timeout now preserves the original PDF,
  removes the hidden window/renderer/staging root, reports the error, and leaves
  the shell responsive.

Focused fresh evidence: PDF journal/identity/memory/runner 30/30 PASS, PDF
typecheck and targeted ESLint/format PASS, PDF and Shell builds PASS, and the
real Electron lifecycle E2E 2/2 PASS in 13.3 seconds. Full repository regression
is recorded above; remote CI remains required after this checkpoint is
committed.

## 2026-08-13 PDF isolation and external release preflight

This checkpoint preserves the existing dirty working tree and performs no
publish, provider call, signing, notarization, or update delivery.

- A side-effect-free `release:preflight` now reports dependency, declared
  source SHA, clean worktree, selected Developer ID, secure timestamp,
  notarization configuration, and credential-free HTTPS update readiness
  without printing credential values. `release:mac:package` enforces this gate
  before the canonical macOS distribution command. On the current tree it
  reports dependency PASS, dirty-worktree FAIL, and source/signing/
  notarization/update/AI-operations HOLD.
- Microsoft Office manual evidence now has a machine-verifiable manifest
  contract. The verifier binds the exact release artifact, input fixtures,
  Office-saved documents, and at least three screenshots per application to
  SHA-256; requires complete Word/Excel/PowerPoint version and assertion data;
  and rejects absolute/traversing paths, symlinks, oversized/unsafe manifests,
  missing files, and changed bytes. This validates packet integrity, not the
  human visual judgment, and currently fails closed because no evidence packet
  exists.

- PDF transforms remain in an Electron sandboxed renderer rather than moving
  the malicious-document parser into `utilityProcess`. Electron utility
  processes are Node.js-integrated, and Node's permission model is not a
  security boundary for hostile code; that move would expand filesystem and
  network privilege compared with the existing sandbox. The main process sends
  only a bounded dispatch and receives no renderer IPC. Inputs and outputs use
  authenticated one-shot custom-protocol streams backed by owner-only staged
  files.
- The trusted main process now samples the isolated renderer's current and peak
  OS working set (plus Windows private bytes) every 25 ms and fails the
  transform closed above 768 MiB. Missing metrics after `dom-ready` also fail
  closed instead of silently disabling enforcement. The queue then
  force-crashes the renderer, destroys its hidden window, and cleans staged
  files. A real Electron negative E2E lowers the unpackaged-only test ceiling,
  proves the error reaches the UI, and proves the original PDF remains
  byte-identical. This is an enforced sampled kill-switch, not a kernel-hard
  allocation reservation; a sufficiently abrupt spike can briefly exceed the
  threshold between samples.
- All five applications, the root toolchain, and all Electron builders now pin
  `electron@41.10.3` exactly. The lock and installed tree contain one hoisted
  Electron binary and `@electron-internal/extract-zip@1.0.5`; the vulnerable
  legacy `extract-zip` package is absent. The release dependency gate also
  rejects an unreviewed Electron major, stale installed binary, artifact
  override environment, or Node below 22.12 before packaging.
- An isolated clean copy installed and built all five applications under Node
  20.20.2/npm 10.8.2, but Electron 41.10.3 and its tooling declare Node >=22.12.
  Node 20 is therefore compatibility evidence only and the release gate rejects
  it. A second isolated copy installed and built cleanly under Node 22.23.2/npm
  10.9.8 without engine warnings. The repository `engines` and `.nvmrc` now
  select this supported baseline.
- With the user's explicit authorization to send dependency names and versions
  to the public npm registry, current online full and production audits both
  returned 0 vulnerabilities across 910 dependency records. This supersedes
  the prior Electron 41.7.1 and legacy extract-zip findings; offline cache
  output is not used as release evidence.
- The tracked LibreOffice compatibility corpus freshly passed 3/3 structural
  round trips. Microsoft Excel 16.105.3 and PowerPoint 16.105.1 are installed;
  Word is missing. An isolated Excel fixture round-trip attempt timed out before
  producing an Office-authored output, and screen capture was unavailable, so
  it is not counted as compatibility evidence. Microsoft Office bidirectional
  visual/manual compatibility remains HOLD. The exact fixtures, observations,
  screenshots, versions, and pass criteria are recorded in
  `docs/microsoft-office-manual-qa.md`.
- The existing final DMG passed `hdiutil verify`, but it predates this dirty
  source and is not a release candidate. Its embedded app reports hardened
  runtime and Team ID `3FG9QJC8WC`, while local strict trust verification fails
  and no stapled-ticket evidence was established. The loose app is stale and
  invalid. This Mac currently exposes no valid Developer ID signing identity,
  the explicit signing/notarization gates and credentials are unset, and the
  artifact contains no `app-update.yml`.
- Update publication remains disabled when no URL is supplied. A configured
  generic channel now requires a canonical credential-free HTTPS URL and
  rejects HTTP, embedded credentials, query strings, fragments, whitespace,
  and malformed values before packaging. A real signed update from version N
  to N+1 remains HOLD until an authorized HTTPS channel and two exact release
  artifacts exist.
- Release identity generation now refuses tracked or untracked worktree changes
  before writing the source/payload receipt. A dirty build can no longer claim
  the current Git HEAD as complete provenance. The present working tree is
  intentionally dirty, so packaging an exact release candidate correctly
  remains blocked until the reviewed changes are committed.
- The canonical macOS and Windows distribution commands now start with
  `audit:release-dependencies`. It requires reviewed Electron 41.10.3, exact
  matching pins in all five apps and builder configs, a matching installed
  binary, Node 22.12 or newer, and no checksum/binary-path override environment.
  It passes on the current dependency tree and deliberately fails on Node 20.

Fresh post-change verification: PDF 243/243 tests, Shell 235/235 tests, all
workspace JavaScript/TypeScript tests 3,863 passed / 2 skipped, Sheets Rust
53/53 passed, all workspace typechecks PASS, lint 0 errors / 8 pre-existing
React hook warnings, all five production builds PASS, full Electron E2E 17/17
PASS in 49.0 seconds, full changed-file formatting PASS, and `git diff --check`
PASS.
The generated PDF main bundle contains no `PDFDocument` or `pdf-lib`; those
symbols remain only in the sandbox job preload.

The release-preflight and Office-evidence additions retain focused negative and
positive coverage in the passing Shell suite. Fresh current-host report-only
execution has dependency PASS, dirty-worktree FAIL, and source/signing/
notarization/update HOLD. Enforce mode exits 1 before packaging, and the default
Office evidence verification exits 1 without a source-bound evidence packet.

### Checkpoint decision

- **PASS (local implementation):** sandbox stream isolation, sampled 768 MiB
  kill-switch, fail-closed PDF E2E, HTTPS update URL validation, exact Electron
  41.10.3 lock/binary, clean Node 20 compatibility build, clean Node 22 release
  build, online audit with 0 findings, and LibreOffice corpus.
- **HOLD (external release evidence):** Microsoft Office manual testing,
  Developer ID signing and secure timestamp,
  notarization/stapling/Gatekeeper on the exact source-bound artifact, and a
  real N-to-N+1 updater exercise.

## 2026-08-13 prioritized hardening follow-up

This follow-up is fresh local implementation evidence on the same branch and
dirty baseline. It performed no provider call, signing, notarization, publish,
or distribution action.

- The restart-reset AI daily gate now persists only UUID/timestamp/token totals
  in an owner-only atomic ledger. Normal packaged Docs, Sheets, Slides, and the
  unified shell share the canonical `GenOffice` ledger. Packaged production
  builds reject environment-controlled user-data overrides; unpacked runs may
  still use isolated scratch data. All packaged AI smoke drivers now fail
  closed before app spawn until a separately built smoke artifact provides a
  compile-time scratch-profile contract.
  Corrupt, unsafe, busy, or unwritable storage fails closed. Independent gates
  serialize reservations, unused pre-provider reservations roll back, and
  prompts, request IDs, file content, and account data are not stored.
  Reservations fsync the ledger file and its parent directory after atomic
  rename so a completed local charge survives normal restart and macOS power
  loss under the filesystem durability contract.
- The PDF directory claim-budget lock is no longer deleted after a PID
  liveness guess. A contended or crashed lock blocks in-place Save before any
  source mutation, preserves replacement-lock bytes through ABA races, and
  directs recovery to Save As or exact manual lock removal only after every
  GenOffice process is closed.
- PDF transformation inputs now move through SHA-256-bound owner-only staging
  files and one-shot custom-protocol streams instead of whole-document
  structured-clone IPC. Output bytes and their bounded result metadata return
  through the same authenticated one-shot protocol; the main process has no
  renderer-to-main IPC listener at all and never imports `pdf-lib`. Main starts
  the job from its own hidden-page `dom-ready` event and sends only the bounded
  dispatch. Source and inserted
  PDFs are rechecked for path type, size, mtime, and full hash while a fixed
  1 MiB buffer stages them. The sandbox remains the only process that
  materializes a complete input for `pdf-lib`.
- The remaining identified dev dependency advisories were removed or pinned:
  PptxGenJS runtime generation was replaced by seven tracked PptxGenJS 4.0.1
  interoperability fixtures, removing unpatched `image-size`; the PostCSS path
  is locked to `nanoid@3.3.17`. The downloaded public nanoid tarball matched its
  published SHA-512 integrity. The later clean-install bulk advisory response
  supersedes this checkpoint and is recorded above. The Electron and
  extract-zip HIGH advisories identified at that point are now remediated.
- `npm run compat:libreoffice` now round-trips tracked DOCX footnotes, an XLSX
  workbook with three sheets and two charts, and a five-slide PPTX through an
  isolated LibreOffice profile under an OS temporary directory. It preserves
  the selected core structural counts and never overwrites fixtures. This is a
  smoke gate, not Microsoft Office visual-fidelity proof.

### Fresh focused evidence

- AI provider: 156 tests PASS; typecheck PASS. Docs, Sheets, Slides, and Shell
  typechecks PASS after the persistent gate was connected.
- PDF: 237 tests PASS; typecheck, targeted lint, formatting, and build PASS,
  including streamed-file hash mismatch, symlink, partial cleanup, output cap,
  dead-looking/live PID locks, and replacement-lock ABA preservation.
- PPTX engine: 529 tests PASS; typecheck PASS with static external-producer
  fixtures and no PptxGenJS/image-size lock entry.
- LibreOfficeDev 26.8 corpus: 3/3 structural round trips PASS.
- Full JavaScript/TypeScript suite: 3,841 passed / 2 skipped; Sheets Rust
  sidecar: 53 passed. Full lint completed with 0 errors / 8 pre-existing React
  hook warnings; all workspace typechecks and the five-app build passed.
- Full Electron E2E: 15/15 PASS in 52.9 seconds on the permitted macOS app
  execution surface. The shutdown helper now fails if the process requires its
  20-second forced-kill fallback; the suite therefore proves graceful exit as
  well as editor behavior. An earlier sandbox run failed all 14 before launch with
  `SIGABRT`/`EPERM` and is not counted as product evidence.
- Focused PDF E2E after the stream transport and memory change: 4/4 PASS for
  memory-limit fail-closed behavior, annotation save/reopen, external
  replacement preservation plus recovery copy, and crash recovery
  creation/cleanup.
- macOS side-effect/provenance gate: 21/21 PASS. No signing, Keychain lookup,
  notarization, stapling, or updater publish was performed.
- macOS bundle-size gate records the raw app, Electron framework, bundled Codex
  runtime, Office modules, native sidecars, and shell ASAR independently and
  fails release checks if any configured ceiling regresses. This makes a future
  Electron-to-system-WebView comparison evidence-based rather than relying on
  the total installer size alone.
- `git diff --check`: PASS for the combined working tree at this checkpoint.

### Follow-up gates

1. **Dependency maintenance owner:** keep Electron on the reviewed 41.x line,
   rerun the approved online audit for each release candidate, and review any
   future major before changing the enforced baseline. The current lock,
   installed binary, clean Node 22 tree, and online audit are aligned.
2. **PDF runtime owner:** the main-process large-binary deserialization path is
   closed by the bounded one-shot protocol broker, and a 768 MiB sampled
   working-set kill-switch now terminates the sandbox. A compact malicious PDF
   may briefly exceed the threshold between 25 ms samples before termination;
   use a platform-enforced memory reservation before claiming a kernel-hard
   object-bomb ceiling.
3. **PDF recovery owner:** replace commit-journal PID-only ownership with an OS
   advisory lock or process-start/nonce generation protocol. The claim-budget
   lock ABA/PID-reuse deletion path is closed, but an unrelated reused PID can
   still delay interrupted-path repair.
4. **Compatibility owner:** run manual Word/Excel/PowerPoint open-edit-save-
   reopen and pixel/visual comparison on the exact release artifact. The local
   LibreOffice structural corpus does not substitute for Microsoft Office.
5. **Release owner:** signing, secure timestamp, notarization, stapling,
   Gatekeeper, clean-machine launch, and a real HTTPS update channel remain
   HOLD and require explicit credentials and distribution authorization.

## 2026-08-13 malicious-document and editor round-trip gate

This section records fresh local evidence on branch `agent/codex-sdk`, baseline
HEAD `045dcfb4e4515cc28f50bc44eb015c58eada6f9c`, with the existing dirty
packaging/PPTX work preserved. It is implementation and local QA evidence only;
no signing, notarization, updater publish, provider call, or distribution step
ran.

### Implemented controls

- Exact runtime versions now resolve to `pdfjs-dist@5.4.149`,
  `@univerjs/core`'s `nanoid@5.1.16`, and `js-yaml@4.3.1`. The PDF.js pin keeps
  the repository's Node 20 runtime while moving out of the identified
  `>=5.6.83 <6.2.108` advisory range; a current approved online audit is still
  required before release.
- AI attachment parsing rejects files over 50 MB, ZIPs with more than 10,000
  entries, parts over 64 MB, expanded archives over 512 MB, unsafe ZIP paths,
  and extracted text over 2 MB. PDF text extraction also fails closed on parser
  errors, caps image objects and page counts, and disables PDF.js expression
  evaluation; the interactive PDF viewer uses the same no-eval/image bounds.
- Docs, Sheets, and Slides now grant canonical attachment paths per
  `webContents` only after a native picker, genuine dropped `File`, or bounded
  pasted-image flow. Text/image reads and Slides evidence-hash refreshes deny
  ungranted paths; grants are cleared with the tab, and replaced symlinks fail
  closed.
- Added real Electron save/reopen coverage for Slides theme application, Docs
  text edits, and PDF rectangle annotations. The tests use temporary copies or
  generated fixtures, verify the persisted OOXML/PDF object, then reopen in a
  fresh process.
- Slides can inspect a source presentation in a bounded worker, preview its
  colors/fonts, and apply the selected design without importing source slides.
  Destination `themeOverride` parts are patched only where an override already
  exists; format/effect sections, relationships, unsupported source overrides,
  and unrelated OOXML remain protected. Save/session revision checks prevent a
  late save from replacing a newly opened or newly edited deck.
- Docs has an application-boundary footnote fidelity regression: editing one
  imported footnote and reopening preserves the untouched sibling footnote,
  separator records, and all 20 body references byte-for-byte where expected.
- Streamed XLSX workbooks now have a real UI regression for sparse large-range
  formula closure: a precedent edit recalculates its dependent formula, Save
  preserves the original formula and untouched OOXML marker, and a fresh app
  process reopens the calculated value. The Sheets architecture/interface/
  compatibility notes were reconciled with the shipped editable-stream mode.
- PDF views now render and save from an immutable session snapshot. In-place
  Save hashes the live source first; an external replacement is preserved and
  the complete pending edit is written to a separate conflict-recovery PDF.
  Claim journals repair a source pathname after an interrupted commit, retained
  owner-only claim inodes prevent open-file writers from being discarded, and
  source aliases resolve to one canonical mutation identity. Main-process
  validation bounds source files to 128 MB, editable sources to 64 MB, combined
  transform input/output to 96 MB, editable documents to 20,000 pages, and
  markup/drawing/stamp/form/page-operation payload counts, coordinates, text,
  and image bytes before PDF mutation begins.
- Dirty PDFs write an atomic PDF plus SHA-bound manifest under the app's local
  recovery directory every 30 seconds and on blur without touching the source.
  Each complete PDF/manifest generation is written before an atomic current
  pointer advances, so a crash cannot tear the only recoverable generation. On
  reopen, a recovery is restorable only while the original still matches its
  captured SHA; otherwise the app retains/reveals the separate recovery and
  never overwrites the externally changed source. A successful Save or explicit
  Don't Save clears stale recovery state.
- All `pdf-lib` parsing/mutation now runs in a hidden one-shot sandboxed Electron
  renderer, not the privileged main bundle. Its non-persistent session denies
  permissions, downloads, navigation, windows, webviews, HTTP(S), and WebSocket;
  a 120-second absolute deadline, owner cancellation, one-active/one-queued cap,
  post-mutation page/object budgets, and authenticated 1 MB ACK result chunks
  bound the cooperative job path. The production main bundle contains no
  `PDFDocument`/`pdf-lib`; only the isolated job preload does.
- Docs, Sheets, Slides, and the shared PDF AI surface now require a random,
  main-issued job capability bound to one `webContents`. Jobs reject cross-tab
  use, replay, overlapping paid turns, excessive input, more than 16 provider
  turns, and more than 8,192 cumulative estimated output tokens. Each turn is
  limited to 2,048 output tokens; the structured Codex envelope is bounded as a
  whole and permits at most one tool call per turn, and observed overage closes
  the job instead of being hidden by accounting. The Sheets sandboxed preload
  bundles these validators and contains no unresolved workspace-package
  require.

### Fresh verification

- Node/runtime: mise Node 20.20.2, matching `.nvmrc`.
- `npm run lint`: PASS, 0 errors / 8 existing React hook warnings.
- `npm run typecheck`: PASS across every workspace.
- `npm test`: PASS, 3,780 passed / 2 skipped; the Sheets Rust sidecar also
  passed 53 tests.
- `npm run build:all`: PASS for Docs, Sheets, Slides, PDF, and Shell.
- Full Electron E2E: PASS, 14/14 in 2.9 minutes. Coverage includes Shell home,
  localization, onboarding and quick-create; Docs text and footnote
  save/reopen; Sheets ordinary, new-blank, and streamed-formula save/reopen;
  PDF annotation, external-source conflict, and crash-copy recovery; and Slides
  design apply/save/reopen.
- Final read-only security diff review: HIGH 0 / MEDIUM 0 for the implemented
  changes. AI provider negative tests passed 146/146; ticket ownership,
  whole-response output budgeting, terminal overage handling, and the bundled
  Sheets preload were rechecked against the built output.
- `git diff --check`: PASS.
- `npm run format:check`: HOLD only on the pre-existing untracked
  `.omx/context/codexoffice-pptx-design-import-20260812T124306Z.md`; all source
  files changed by this gate pass formatting.
- `npm ls pdfjs-dist js-yaml nanoid --all`: PASS with the versions listed
  above. `npm audit --offline --omit=dev` reports 0 findings across 259
  production dependencies, but offline cache coverage is not release proof.

### Remaining gates

1. **Dependency owner:** clean Node 22 install and explicitly approved current
   online production/full audits are complete with 0 findings. Re-run them on
   the final exact-SHA release candidate.
2. **PDF runtime owner:** repeated-transform and timeout lifecycle evidence is
   complete. The 768 MiB watchdog remains an enforced sampled kill-switch, not
   a kernel allocation reservation; do not move hostile PDF parsing into a
   Node-integrated utility process merely to obtain V8 heap flags.
3. **PDF storage owner:** claim-budget ABA deletion and commit-journal PID reuse
   are closed. Preserve the adjacent bounded claim history until a coordinated
   cross-application file replacement primitive is available.
4. **AI operations owner:** local restart-durable spend accounting is now
   implemented. Provider/account hard caps, alerts, and a distributed ledger
   remain mandatory before calling it a Production cost ceiling.
5. **PDF product owner:** professional workflows remain open: cryptographic
   signature validation/signing, OCR and true redaction, tagged-PDF
   accessibility, and encrypted-document save where policy permits it.
6. **Compatibility owner:** expand the Office corpus to PowerPoint/Word/Excel
   and LibreOffice visual comparisons; the new E2E proves local round trips, not
   third-party rendering fidelity.
7. **Release owner:** signing, secure timestamp, notarization, stapling,
   Gatekeeper, clean-machine, and real updater-channel evidence remain HOLD.

## 2026-08-11 exact-SHA local gate rerun

This section is fresh local evidence for
`045dcfb4e4515cc28f50bc44eb015c58eada6f9c`. The 2026-08-10 signed package,
authenticated provider runs, and their hashes remain historical evidence below;
they are not promoted to current provider, notarization, updater, or Production
proof.

### Baseline and fresh verification

- Branch: `agent/codex-sdk`; HEAD:
  `045dcfb4e4515cc28f50bc44eb015c58eada6f9c`.
- The working tree includes the pre-existing ledger/portfolio plan plus this
  uncommitted packaging P0 fix, tests, and deep-pass plan. No reset, stash,
  clean, checkout, or unrelated-file overwrite was performed.
- Repository runtime: `.nvmrc` requests Node 20. Fresh commands ran through
  mise Node 20.20.2 / npm 10.8.2. The shell's default Node 26.0.0 / npm 11.12.1
  is a compatibility mismatch and was not used for the release verification.
- `npm run format:check`: PASS.
- `npm run lint`: PASS, 0 errors / 8 existing React hook warnings.
- `npm run typecheck`: PASS.
- `npm test`: PASS, 3,699 passed / 2 skipped.
- Rust sidecar `cargo test --locked`: PASS, 53 passed.
- `npm run build:all`: PASS.
- Focused cost/abuse negative paths: `codex-image.test.ts` PASS, 11 tests.
- Focused macOS side-effect/provenance paths: `mac-release-gates.test.ts` PASS,
  21 tests. Shell suite: 185/185 PASS.
- Production build-hook secret-pattern scan (excluding test/fixture/evidence
  paths): no matching secret patterns.

### Offline production dependency triage

- `npm audit --offline --omit=dev`: PASS for the locally cached advisory corpus,
  0 reported vulnerabilities across 259 production dependencies.
- This does **not** close the dependency gate: the stored 2026-08-10 result was
  47 high findings, and an offline cache cannot prove current advisory coverage.
- Installed risk-bearing paths still include `pdfjs-dist@5.7.284` through
  `@genoffice/file-parse` into Sheets, `js-yaml@4.3.0` through the updater/build
  chain, and `nanoid@3.3.16` in the build/UI dependency graph. Dependency owner
  must run an approved current advisory scan and fix or formally accept each
  reachable production finding before notarized release approval.

### Fresh unsigned local artifacts

The normal `dist:mac` path produced these artifacts after the signing gate fix.
The environment explicitly removed signing, Apple, updater, and provider
credentials; set `CSC_IDENTITY_AUTO_DISCOVERY=false`; and declared the exact
source SHA. The build used the installed pinned Electron 41.7.1 distribution,
so no package payload download was required. The log proves electron-builder
used `identity:null`, the repair hook denied signing, and the notarization hook
denied notarization. No Keychain lookup, `signAsync`, timestamp, notarytool,
stapler, updater publish, or provider call ran.

| Artifact                                         | SHA-256                                                            |        Size |
| ------------------------------------------------ | ------------------------------------------------------------------ | ----------: |
| `apps/shell/release/Codexoffice-0.5.0-arm64.dmg` | `b0dd94468622a3cac106517b3251f50483e1ae1f7ef968ebf3d49b42a57c8a50` | 265,739,745 |
| `apps/shell/release/Codexoffice-0.5.0-arm64.zip` | `5ed0a8fccbcff70558ddd6ff559e9fc21eb0af04eeee12b93672081060668b34` | 265,922,888 |

- Identity on builder, ZIP-extracted, and DMG-mounted app:
  `com.genoffice.app`, version/build `0.5.0`, arm64.
- Their release-identity receipt hashes all equal
  `a4013aee5fb6087720333b0a68750973861cc790e4d88a6d8b2efde0f113430d`,
  and their independently recomputed `app.asar` hashes all equal
  `cfd75fcdfecea858a52dba905623d2417a3e6b3331149e5bdfd9cbf97184d4c5`.
- `app-update.yml`: absent on all three surfaces, which is the expected
  fail-closed local behavior when the update URL is unset.
- Embedded source SHA:
  `045dcfb4e4515cc28f50bc44eb015c58eada6f9c`. Stale declared SHA and modified
  payload tests fail closed. Because the packaging fix is intentionally
  uncommitted, the receipt binds baseline HEAD plus actual payload bytes; the
  external ledger remains authoritative for final ZIP/DMG bytes.
- Signature/distribution: expected HOLD. Outer signature is ad hoc/linker-signed
  with no Team ID; strict deep codesign and Gatekeeper assessment fail. Stapler
  validation was not invoked in this pass. These artifacts are local smoke
  inputs only.
- Isolated offline package smoke: PASS for Home (hero and four quick cards),
  Docs (editable surface), Sheets (name box and deterministic AI Check button),
  and Slides (AI input surface). HOME/user-data were temporary, sign-in was not
  attempted, image/provider generation was disabled, and no paid call ran.

### Residual gates

1. **Packaging maintainer — closed locally on 2026-08-11:** the standard package
   path honors autodiscovery disabled, `identity:null`, authorization, and
   timestamp gates; 21 negative/provenance tests and a fresh package log prove
   zero forbidden side effects. Commit/review remains outside this task.
2. **Dependency owner — before notarized release approval:** run an approved
   current production advisory scan and resolve or formally accept reachable
   findings; the offline zero result is insufficient.
3. **Release owner — before distribution:** use an explicitly approved identity,
   secure timestamp, notarization submission, staple validation, Gatekeeper
   assessment, and clean-machine launch on one exact artifact hash.
4. **Release owner — before updater publish:** validate an approved HTTPS
   `GENOFFICE_UPDATE_URL`, generated `app-update.yml`/`latest-mac.yml`, exact
   artifact digest/size, atomic publish, downgrade rejection, and real upgrade.
5. **Operations + backend owners — before provider Production enablement:**
   verify durable distributed quotas, auth/entitlement before paid work, hard
   account/global budget, redacted cost attribution, alerts, and a server-side
   kill switch. Current in-process quotas and enable flag are local defense in
   depth, not deployed spend control.

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
