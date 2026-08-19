# AI operations release gate

Status: **HOLD — provider/account evidence is not configured.** Local request
budgets, persistent ledgers, concurrency limits, timeouts, and kill switches are
defense in depth; they do not prove that a provider account cannot overspend
across several machines or after a local client is compromised.

Before packaging a Production candidate:

1. Configure a provider-enforced daily or monthly hard spend cap.
2. Enable an alert at or below 80% of that cap and verify delivery.
3. Exercise both the provider kill switch and `GENOFFICE_AI_DISABLED=1` without
   sending paid work after the switch.
4. Verify the provider account usage view aggregates two separate clients.
5. Export a redacted cost-attribution log containing request counts, reserved
   token budgets, allow/deny decisions, and stable reason codes, but no prompts,
   document contents, request IDs, or account identifiers.
6. Redact account IDs, emails, API keys, cookies, request contents, and billing
   details from screenshots. Hash a private account identifier with a private
   salt and store only the resulting SHA-256 fingerprint in the manifest.

Copy `docs/ai-operations-evidence.example.json` beside the redacted evidence
files as `ai-operations.json`. Bind it to the exact release source SHA, replace
all placeholders, and run:

```sh
GENOFFICE_SOURCE_SHA=<exact-40-character-release-SHA> \
  npm run verify:ai-operations-evidence -- /absolute/path/to/ai-operations.json
```

The manifest and every artifact must be regular, non-symlink files under one
evidence directory, and each artifact is capped at 20 MiB before hashing.
Evidence or a kill-switch exercise older than 30 days, a cap that is not
provider enforced, an alert above 80%, an untested kill switch, missing
multi-client aggregation or cost-attribution log, a path escape, or a digest
mismatch fails closed. The verifier checks source binding and packet integrity;
it cannot independently query or guarantee provider state.

Set `GENOFFICE_AI_OPERATIONS_EVIDENCE` to the absolute verified manifest path
when running `npm run release:mac:package`. The canonical preflight remains
HOLD without it and reports only generic status, never evidence paths or
credential values.
