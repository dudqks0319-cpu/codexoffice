# GenOffice trusted AI workflow context

## Task statement

Preserve the current Codex SDK/model work in GitHub, then implement in order:
reviewable and recoverable AI changes, deterministic Sheets QA, and an
evidence-linked editable three-slide PPT workflow. Verify the packaged macOS
application and retain screenshot evidence.

## Desired outcome

- AI edits do not write the source document before explicit review/approval.
- Cancellation, source changes, failed validation, and app restart fail safely.
- Sheets reports deterministic QA findings without calling unsupported formulas safe.
- Excel-derived PPT content retains source locators and editable structure.
- Relevant tests, builds, packaged smoke checks, and screenshots are reproducible.

## Known facts and evidence

- Baseline branch: `agent/codex-sdk`.
- Baseline commit pushed to GitHub: `e1dcd1a`.
- Fresh baseline checks: format PASS, lint 0 errors/8 existing warnings,
  typecheck PASS, full test suite PASS.
- Existing AI transports cover Docs, Sheets, Slides, and PDF.
- Existing packaged QA and model comparison artifacts are under `qa-artifacts/`.
- Current distribution gates include notarization, update signing/configuration,
  and 47 high production dependency findings.

## Constraints

- Preserve user changes and use minimal, reviewable diffs.
- No public-release claim from local build or package evidence alone.
- Do not log document contents, prompts, credentials, or raw sensitive values.
- Do not silently switch models or automatically retry expensive operations.
- Use feature flags/internal alpha boundaries where a complete production path is
  not achievable within the current implementation slice.

## Unknowns to resolve by inspection

- The narrowest shared boundary for job state, cancellation, staging, and recovery.
- Existing command/diff representations reusable across Docs, Sheets, and Slides.
- Workbook formula/chart metadata available without executing macros or links.
- Existing PPT object metadata that can safely carry source references.

## Likely touchpoints

- `packages/agent-core/`
- `packages/ai-provider/`
- `packages/project-store/`
- `apps/docs/src/`
- `apps/sheets/src/`
- `apps/slides/src/`
- `apps/shell/src/`
- corresponding tests and packaged smoke drivers
