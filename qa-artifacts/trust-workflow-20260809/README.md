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
- Slides bitmap generation/insertion: PASS in the separate isolated authenticated
  smoke. Codex returned a 1536×1024 PNG and the packaged app inserted one native
  picture node. See `authenticated-image-smoke.json` and screenshot 08.
- Luna/max evidence deck: PASS in the separate isolated authenticated smoke —
  exactly three native-editable slides, page-scoped `REVIEW_READY`/apply, trusted
  evidence notes on every page, and final `COMMITTED`. See
  `luna-max-evidence-smoke.json` and screenshots 09-12.

Machine-readable details are in `packaged-smoke.json`. Screenshots 01-06 are
the same run and must be reviewed together with that JSON timestamp.

## Final local artifacts

| Artifact                                               | SHA-256                                                            |              Size |
| ------------------------------------------------------ | ------------------------------------------------------------------ | ----------------: |
| `apps/shell/release-final/Codexoffice-0.5.0-arm64.dmg` | `629e24618addc04ebad2d62a6dd0e64ad1f5fc0eef4e7720051c64ae594e2523` | 296,365,003 bytes |
| `apps/shell/release-final/Codexoffice-0.5.0-arm64.zip` | `0feb0bc9bd045c0344624c1fc82c5ff8b9111c4a43a052b3c7cab9f7bd5c0a98` | 263,678,441 bytes |
| `luna-max-evidence-deck-reconstructed.pptx`            | `f42161173ad1a83c369265026b894215b9647b6558533f69d475ee674d88c275` |     114,322 bytes |

`codesign --verify --deep --strict` passed for the isolated signed staging app,
the ZIP extraction, and the DMG-mounted app. These local artifacts are
deliberately untimestamped and unnotarized, so they are QA candidates, not
public release artifacts.

The reconstructed PPTX is an offline native-editable reproduction of the
visibly committed Luna/max deck. The model-run evidence is the screenshot/JSON
set; the original model-written draft byte stream was excluded because the first
automation copied it before the streaming ZIP writer closed. The repaired driver
now requires the visible Saved status plus a stable ZIP central directory.
