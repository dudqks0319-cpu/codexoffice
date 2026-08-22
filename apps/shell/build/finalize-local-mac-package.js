const { execFileSync } = require('node:child_process')
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, join, resolve } = require('node:path')
const repairMacSignature = require('./repair-mac-signature.js').default

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' })
}

function verifyApp(appPath) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
}

async function main() {
  if (process.platform !== 'darwin' || process.env.GENOFFICE_LOCAL_UNTIMESTAMPED_SIGN !== '1') {
    return
  }

  const shellDir = resolve(__dirname, '..')
  const sourceApp = join(shellDir, 'release', 'mac-arm64', 'Codexoffice.app')
  const finalDir = join(shellDir, 'release-final')
  if (!existsSync(sourceApp)) throw new Error(`Packaged app is missing: ${sourceApp}`)

  // Never archive the electron-builder output in place. Some builder workers
  // can continue touching that bundle after the main command reports success,
  // invalidating a signature that was valid only moments earlier.
  const workDir = mkdtempSync(join(tmpdir(), 'genoffice-local-package-'))
  const signedDir = join(workDir, 'signed')
  const signedApp = join(signedDir, basename(sourceApp))
  const dmgRoot = join(workDir, 'dmg-root')
  const zipVerifyDir = join(workDir, 'zip-verify')
  const dmgMount = join(workDir, 'dmg-mount')

  mkdirSync(signedDir, { recursive: true })
  mkdirSync(finalDir, { recursive: true })
  run('/usr/bin/ditto', [sourceApp, signedApp])

  try {
    await repairMacSignature({
      appOutDir: signedDir,
      packager: { appInfo: { productFilename: 'Codexoffice' } },
    })
    verifyApp(signedApp)

    const finalZip = join(finalDir, 'Codexoffice-0.5.0-arm64.zip')
    const finalDmg = join(finalDir, 'Codexoffice-0.5.0-arm64.dmg')
    rmSync(finalZip, { force: true })
    rmSync(finalDmg, { force: true })

    run('/usr/bin/ditto', [
      '-c',
      '-k',
      '--sequesterRsrc',
      '--keepParent',
      signedApp,
      finalZip,
    ])

    mkdirSync(dmgRoot, { recursive: true })
    run('/usr/bin/ditto', [signedApp, join(dmgRoot, 'Codexoffice.app')])
    symlinkSync('/Applications', join(dmgRoot, 'Applications'))
    run('/usr/bin/hdiutil', [
      'create',
      '-volname',
      'Codexoffice',
      '-srcfolder',
      dmgRoot,
      '-ov',
      '-format',
      'UDZO',
      finalDmg,
    ])

    // Verification is against what users actually receive, not the staging app.
    mkdirSync(zipVerifyDir, { recursive: true })
    run('/usr/bin/ditto', ['-x', '-k', finalZip, zipVerifyDir])
    verifyApp(join(zipVerifyDir, 'Codexoffice.app'))

    mkdirSync(dmgMount, { recursive: true })
    run('/usr/bin/hdiutil', [
      'attach',
      '-nobrowse',
      '-readonly',
      '-mountpoint',
      dmgMount,
      finalDmg,
    ])
    try {
      verifyApp(join(dmgMount, 'Codexoffice.app'))
    } finally {
      run('/usr/bin/hdiutil', ['detach', dmgMount])
    }

    console.log('[mac-sign] verified final local ZIP and DMG in apps/shell/release-final')
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
