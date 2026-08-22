# macOS update release gate

Status: **HOLD — a signed and notarized N-to-N+1 channel exercise has not been
performed.** A syntactically valid HTTPS URL and unit tests do not prove that a
real installed release can discover, download, verify, install, relaunch, and
recover safely from an update failure.

Before packaging a Production candidate:

1. Build, sign, notarize, and staple the exact previous and next release
   artifacts from recorded source SHAs.
2. Publish the next ZIP and `latest-mac.yml` to the approved credential-free
   HTTPS channel. Extract the installed previous app's `app-update.yml`.
3. Install version N on a clean macOS account, create a recognizable local
   document and settings marker, and record their hashes without storing
   document contents in the evidence packet.
4. Confirm the app offers N+1, downloads it, verifies its signature, installs
   it, relaunches as N+1, and preserves the marker and user document.
5. Repeat from N with either a deliberately unavailable download or an invalid
   signature. Confirm no install/restart occurs, N and the user-data hashes are
   preserved, and a later retry succeeds.
6. Redact account names, local paths, tokens, cookies, signing credentials, and
   document contents from the success and failure observations.

Copy `docs/update-release-evidence.example.json` beside the six required files
as `update.json`, bind every file to SHA-256, and run:

```sh
GENOFFICE_SOURCE_SHA=<exact-40-character-N+1-source-SHA> \
GENOFFICE_UPDATE_URL=https://updates.example.com/codexoffice \
  npm run verify:update-evidence -- /absolute/path/to/update.json
```

The verifier requires stable three-part versions with N+1 newer than N, a
fresh observation no older than 30 days, macOS and architecture metadata, and
six distinct regular non-symlink files under one evidence directory. It checks
that `app-update.yml` uses the exact generic HTTPS channel, and that
`latest-mac.yml` names the exact N+1 ZIP and contains its actual SHA-512. Release
artifacts are hashed in bounded chunks rather than loaded into memory. Metadata
is capped at 1 MiB, each observation at 20 MiB, each release at 2 GiB, and the
packet at 5 GiB.

The packet must assert both a complete successful update and a failed
download/signature attempt that did not install or call `quitAndInstall`, kept
version N and user data intact, and later retried successfully. Unknown fields,
stale timestamps, unsafe URLs, path traversal, symlinks, duplicate evidence,
digest drift, metadata mismatch, or incomplete preservation assertions fail
closed. The verifier proves packet integrity and internal consistency; it does
not independently prove Apple's signature service, the CDN, or the human
observation.

Set `GENOFFICE_UPDATE_EVIDENCE` to the absolute verified manifest path together
with `GENOFFICE_UPDATE_URL` when running `npm run release:mac:package`. The
canonical preflight remains HOLD when only the URL is configured and reports
only generic status rather than paths or verifier errors.
