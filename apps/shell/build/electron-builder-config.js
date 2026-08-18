const { codexExtraResource } = require('../../../tools/codex-electron-runtime.cjs')

function normalizeUpdateUrl(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error('[update] invalid update channel URL')
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('[update] invalid update channel URL')
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('[update] invalid update channel URL')
  }
  return parsed.toString().replace(/\/+$/, '')
}

function createBuilderConfig(
  environment = process.env,
  { resolveCodexExtraResource = codexExtraResource } = {},
) {
  const updateUrl = normalizeUpdateUrl(environment.GENOFFICE_UPDATE_URL)
  const identity = typeof environment.CSC_NAME === 'string' ? environment.CSC_NAME.trim() : ''
  const timestampMode = environment.GENOFFICE_SIGNING_TIMESTAMP_MODE
  const signingEnabled =
    environment.CSC_IDENTITY_AUTO_DISCOVERY !== 'false' &&
    environment.GENOFFICE_SIGNING_AUTHORIZED === '1' &&
    identity.length > 0 &&
    timestampMode === 'secure'
  const notarizationRequested = environment.GENOFFICE_NOTARIZATION_AUTHORIZED === '1'
  const notarizationCredentialsAvailable =
    Boolean(environment.APPLE_KEYCHAIN_PROFILE) ||
    Boolean(
      environment.APPLE_ID && environment.APPLE_APP_SPECIFIC_PASSWORD && environment.APPLE_TEAM_ID,
    )
  if (notarizationRequested && (!signingEnabled || !notarizationCredentialsAvailable)) {
    throw new Error('[notarize] notarization prerequisites unavailable')
  }

  /** @type {import('electron-builder').Configuration} */
  const config = {
    appId: 'com.genoffice.app',
    productName: 'Codexoffice',
    artifactName: 'Codexoffice-${version}-${arch}.${ext}',
    electronVersion: '41.10.3',
    electronDist: '../../node_modules/electron/dist',
    directories: {
      output: 'release',
    },
    files: ['out/**'],
    extraResources: [
      {
        from: 'build/THIRD-PARTY-NOTICES.txt',
        to: 'THIRD-PARTY-NOTICES.txt',
      },
      {
        from: '../../node_modules/electron/dist/LICENSES.chromium.html',
        to: 'LICENSES.chromium.html',
      },
      {
        from: '../docs/out',
        to: 'modules/docs',
      },
      {
        from: '../sheets/out',
        to: 'modules/sheets',
      },
      {
        from: '../slides/out',
        to: 'modules/slides',
      },
      {
        from: '../pdf/out',
        to: 'modules/pdf',
      },
      resolveCodexExtraResource(),
    ],
    fileAssociations: [
      { ext: 'docx', name: 'Word Document', role: 'Editor' },
      { ext: 'xlsx', name: 'Excel Workbook', role: 'Editor' },
      { ext: 'pptx', name: 'PowerPoint Presentation', role: 'Editor' },
      { ext: 'xls', name: 'Excel 97-2003 Workbook', role: 'Editor' },
      { ext: 'csv', name: 'CSV Document', role: 'Editor' },
      { ext: 'pdf', name: 'PDF Document', role: 'Editor' },
    ],
    npmRebuild: false,
    mac: {
      target: ['dmg', 'zip'],
      category: 'public.app-category.productivity',
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.plist',
      identity: signingEnabled ? identity : null,
      notarize: notarizationRequested,
      extraResources: [
        {
          from: '../sheets/native/xlsx-engine/target/release/xlsx-sidecar',
          to: 'native/xlsx-sidecar',
        },
      ],
    },
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      extraResources: [
        {
          from: '../sheets/native/xlsx-engine/target/x86_64-pc-windows-gnu/release/xlsx-sidecar.exe',
          to: 'native/xlsx-sidecar.exe',
        },
      ],
    },
    nsis: {
      oneClick: false,
      allowToChangeInstallationDirectory: true,
    },
    dmg: {
      sign: signingEnabled,
    },
    afterPack: 'build/release-identity.js',
    afterSign: 'build/repair-mac-signature.js',
    afterAllArtifactBuild: 'build/notarize-dmg.js',
  }

  if (updateUrl) {
    config.publish = [
      {
        provider: 'generic',
        url: updateUrl,
        channel: 'latest',
      },
    ]
  }

  return config
}

module.exports = { createBuilderConfig, normalizeUpdateUrl }
