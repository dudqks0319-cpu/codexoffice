# GenOffice trusted AI workflow specification

## Product position

GenOffice must make AI-produced Office work reviewable, verifiable, editable,
and recoverable. Model selection is an implementation detail; the user-facing
contract is what will be read, what will change, how much the run may cost, and
how to cancel or restore it.

## MVP 1 — review, apply, cancel, recover

### Required behavior

- A generated change is not committed before explicit user approval.
- A review card lists affected document units and warnings.
- Rejecting a review deletes the pending proposal without mutating the artifact.
- Applying revalidates the source revision/hash and fails closed on drift.
- A successful apply is one undo unit and remains unsaved until the ordinary
  save pipeline runs.
- Stop prevents remaining tools and late transport responses from applying work.
- Snapshots and journals never enter ordinary logs or chat transcripts.

### Format adapters

- Sheets: existing `ChangePlan`, CAS checks, edit journal, and atomic XLSX writer.
- Docs: existing pre-first-mutation ProseMirror snapshot and atomic DOCX writer;
  add proposal metadata before attempting a deeper block-level diff.
- Slides: existing history batch/snapshot ID and PPTX recovery copy; expose the
  pending/applied/rolled-back lifecycle without persisting deck snapshots in chat.

## MVP 2 — Sheets QA v1

Run deterministic, read-only checks for:

1. Excel error values.
2. Formula-pattern discontinuity.
3. Hardcoded values inside formula columns.
4. Detail/summary total mismatch where deterministically identifiable.
5. Charts referencing missing or empty ranges.
6. External workbook links.
7. Important formulas depending on hidden sheets.
8. Scenario inputs and outputs lacking structural separation.

Unsupported calculation semantics must be `unverified`, never `safe`.
Findings include rule ID, severity, sheet/range, evidence, and suggested action.
Automatic correction must route back through MVP 1 review.

## MVP 3 — evidence-linked editable three-slide PPT

- Fixed structure: summary; analysis; risks/next actions.
- Every managed number/claim carries a workbook source locator and source hash.
- Managed objects are distinguishable from user-owned objects.
- Source changes mark managed content stale; refresh updates only managed areas.
- Deterministic export checks detect flattened text, non-editable chart images,
  overflow, and abnormal object counts.
- Result policy: Luna/max produces the editable structure; after deterministic
  inspection and user approval, Sol/high may perform a bounded visual pass.
- Failure of the visual pass preserves the structural result.

## Security and cost acceptance criteria

- No credential, document body, prompt, cell dump, or snapshot in normal logs.
- Scope and model/reasoning policy are visible before expensive execution.
- No silent model fallback and no automatic high-cost retry.
- Cancellation invalidates late results.
- Macro, external-link, embedded script, and document prompt-injection content
  are treated as data and are not executed.
- Local package success is not a public-release claim.

## Verification

- Unit and negative-path tests for proposal, stale source, replay, cancel, and recovery.
- Targeted app typecheck and tests after each slice.
- Full format, lint, typecheck, test, and build before package QA.
- Packaged macOS smoke and screenshots for review UI, Sheets QA, and generated deck.
