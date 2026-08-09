# GenOffice trust workflow packaged smoke

Verified on macOS arm64 on 2026-08-10 (Asia/Seoul).

## Reproduce

```sh
cd /Users/jyb-m3max/Desktop/codex/genoffice
npm run build:all
GENOFFICE_LOCAL_UNTIMESTAMPED_SIGN=1 CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac -w @genoffice/shell
SMOKE_DIR="$(mktemp -d)"
ditto -x -k apps/shell/release-final/Codexoffice-0.5.0-arm64.zip "$SMOKE_DIR"
GENOFFICE_PACKAGED_APP="$SMOKE_DIR/Codexoffice.app" node scripts/drivers/driver.packaged-smoke.mjs
```

The local-sign command creates final immutable artifacts under
`apps/shell/release-final/`. The smoke driver uses isolated user data and does
not read or persist API keys.

## Result

- Home/package launch: PASS (hero and four quick cards).
- Docs text editing: PASS (`Codexoffice packaged text smoke`).
- Codex settings: PASS (`gpt-5.6-luna` + `max`, including reload persistence).
- Sheets QA v1: PASS; visible `C3: #REF!` produced one critical formula-error
  finding with `Go to range` and `Propose fix` actions.
- Slides surface: PASS; Luna/max status and native slide canvas visible.
- Slides bitmap generation/insertion: BLOCKED-EXTERNAL-AUTH. The isolated app
  correctly stayed at `Waiting…`; no credentials were entered.

Machine-readable details are in `packaged-smoke.json`. Screenshots 01-06 are
the same run and must be reviewed together with that JSON timestamp.

## Final local artifacts

| Artifact                                               | SHA-256                                                            |              Size |
| ------------------------------------------------------ | ------------------------------------------------------------------ | ----------------: |
| `apps/shell/release-final/Codexoffice-0.5.0-arm64.dmg` | `055845059b0ff4a2c76f8c21859b20f7a95010c9169f73a5362e345f2ef198d6` | 296,632,310 bytes |
| `apps/shell/release-final/Codexoffice-0.5.0-arm64.zip` | `92fc2009f234a8d924316bd497d7d9b1788e38b446838f08526339973f7650b5` | 263,678,262 bytes |

`codesign --verify --deep --strict` passed for the isolated signed staging app,
the ZIP extraction, and the DMG-mounted app. These local artifacts are
deliberately untimestamped and unnotarized, so they are QA candidates, not
public release artifacts.
