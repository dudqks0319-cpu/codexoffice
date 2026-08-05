const { codexExtraResource } = require('../../tools/codex-electron-runtime.cjs')

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.genoffice.docs',
  productName: 'GenOffice Docs',
  electronVersion: '41.7.1',
  artifactName: 'AIDocx-${version}-${arch}.${ext}',
  directories: { output: 'release' },
  files: ['out/**'],
  extraResources: [
    codexExtraResource(),
    {
      from: '../shell/build/THIRD-PARTY-NOTICES.txt',
      to: 'THIRD-PARTY-NOTICES.txt',
    },
    {
      from: '../../node_modules/electron/dist/LICENSES.chromium.html',
      to: 'LICENSES.chromium.html',
    },
  ],
  fileAssociations: [{ ext: 'docx', name: 'Word Document', role: 'Editor' }],
  npmRebuild: false,
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.productivity',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: '../shell/build/entitlements.mac.plist',
    entitlementsInherit: '../shell/build/entitlements.mac.plist',
    notarize: true,
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
}
