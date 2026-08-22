// electron-builder afterAllArtifactBuild: notarize + staple the dmg itself
// (the .app inside was already notarized before the dmg was built).
//
// GENOFFICE_NOTARIZATION_AUTHORIZED=1 is the explicit authorization gate.
// Credentials are considered only after that gate, in priority order:
//   1. APPLE_KEYCHAIN_PROFILE                    — local builds (dist:mac)
//   2. APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD +
//      APPLE_TEAM_ID                             — release CI secrets
// Contributor builds omit authorization, so `npm run dist:mac` leaves the DMG
// un-notarized without inspecting or using credential-shaped environment data.
const { execFileSync } = require('node:child_process')

function createNotarizeDmg(dependencies = {}) {
  const environment = dependencies.env ?? process.env
  const currentPlatform = dependencies.platform ?? process.platform
  const runFile = dependencies.execFileSync ?? execFileSync
  const warn = dependencies.warn ?? console.warn

  return function notarizeDmg(result) {
    if (currentPlatform !== 'darwin') return []
    if (environment.GENOFFICE_NOTARIZATION_AUTHORIZED !== '1') {
      warn('[notarize] notarization not authorized; artifacts remain local-only')
      return []
    }
    const { APPLE_KEYCHAIN_PROFILE, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } =
      environment
    let credentialArguments
    if (APPLE_KEYCHAIN_PROFILE) {
      credentialArguments = ['--keychain-profile', APPLE_KEYCHAIN_PROFILE]
    } else if (APPLE_ID && APPLE_APP_SPECIFIC_PASSWORD && APPLE_TEAM_ID) {
      credentialArguments = [
        '--apple-id',
        APPLE_ID,
        '--password',
        APPLE_APP_SPECIFIC_PASSWORD,
        '--team-id',
        APPLE_TEAM_ID,
      ]
    } else {
      throw new Error('[notarize] notarization prerequisites unavailable')
    }
    for (const file of result.artifactPaths.filter((artifact) => artifact.endsWith('.dmg'))) {
      runFile('xcrun', ['notarytool', 'submit', file, ...credentialArguments, '--wait'], {
        stdio: 'inherit',
      })
      runFile('xcrun', ['stapler', 'staple', file], { stdio: 'inherit' })
    }
    return []
  }
}

exports.createNotarizeDmg = createNotarizeDmg
exports.default = createNotarizeDmg()
