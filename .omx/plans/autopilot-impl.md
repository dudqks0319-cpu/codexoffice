# GenOffice trusted AI workflow implementation plan

## Phase A — baseline and contracts

- [x] Commit and push previous Codex SDK/model/QA work (`e1dcd1a`).
- [x] Record context, acceptance criteria, and release boundaries.
- [x] Map existing proposal, snapshot, atomic-save, recovery, and cancellation paths.
- [x] Add shared in-session AI job/proposal state and negative transition tests.

## Phase B — MVP 1

- [x] Make Sheets `propose_operations` non-mutating and review-first.
- [x] Add Sheets review Apply/Cancel controls and regression tests.
- [x] Expose scope/model/reasoning/status in the Sheets job card.
- [x] Add thin Docs/Slides proposal lifecycle adapters over existing snapshots.
- [x] Verify stop, late result, stale source, apply failure, undo, and ordinary save.

## Phase C — MVP 2

- [x] Define `QAFinding` and deterministic scanner contract.
- [x] Implement the eight Sheets rules without evaluating macros/external code.
- [x] Add QA results panel, severity filters, and go-to-cell/range action.
- [x] Route suggested fixes through the review-before-apply flow.
- [x] Add seeded faulty-workbook tests and explicit `unverified` cases.

## Phase D — MVP 3

- [x] Define `EvidenceRef`, managed object ID, and stale-source metadata.
- [x] Add workbook source manifest and three-slide report request.
- [x] Implement editable native-object deck generation and deterministic PPT inspection.
- [x] Add bounded visual/layout QC with structural fallback.
- [x] Add selective managed-object refresh and source-change handling.

## Phase E — validation and evidence

- [x] Run format, lint, typecheck, complete tests, dependency/security review.
- [x] Build arm64 DMG/ZIP and run packaged login/edit/QA/deck smoke.
- [x] Capture screenshots in versioned `qa-artifacts/` directories.
- [x] Update release ledger with PASS/HOLD/BLOCKED-EXTERNAL gates.
- [ ] Commit and push verified implementation slices.

## Design constraints

- Reuse existing `ChangePlan`, editor snapshots, history batches, and atomic writers.
- Keep document snapshots out of project-store chat JSONL.
- Keep each format's mutation engine local; share only lifecycle metadata/state.
- Prefer feature-flagged internal alpha slices over unverifiable production claims.
