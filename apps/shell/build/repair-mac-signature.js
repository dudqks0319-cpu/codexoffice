const { execFileSync } = require('node:child_process')
const { existsSync, statSync } = require('node:fs')
const { join } = require('node:path')
const { signAsync } = require('@electron/osx-sign')

function verify(appPath) {
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

function discoverIdentity() {
  if (process.env.CSC_NAME) return process.env.CSC_NAME
  try {
    const output = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
    })
    const match = output.match(/"([^"]*Developer ID Application[^"]*)"/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

function isCodePath(filePath) {
  if (/\.(?:app|framework|xpc|dylib|node)$/i.test(filePath)) return true
  try {
    return statSync(filePath).isFile() && (statSync(filePath).mode & 0o111) !== 0
  } catch {
    return false
  }
}

exports.default = async function repairMacSignature(context) {
  if (process.platform !== 'darwin') return
  const appName = context.packager.appInfo.productFilename
  const appPath = join(context.appOutDir, `${appName}.app`)
  const forceUntimestampedLocalSign = process.env.GENOFFICE_LOCAL_UNTIMESTAMPED_SIGN === '1'
  if (!existsSync(appPath) || (!forceUntimestampedLocalSign && verify(appPath))) return

  const identity = discoverIdentity()
  if (!identity) {
    console.warn('[mac-sign] embedded signature failed verification; no Developer ID identity found')
    return
  }

  console.warn(
    forceUntimestampedLocalSign
      ? `[mac-sign] applying local untimestamped Developer ID signature for ${appName}`
      : `[mac-sign] repairing embedded signature for ${appName}`,
  )
  // `codesign --deep` can report success while preserving ad-hoc signatures
  // on Electron's dylibs. macOS then refuses to map them into the Developer-ID
  // process because their Team IDs differ. electron-osx-sign walks children
  // deepest-first and explicitly re-signs every framework/helper/dylib.
  await signAsync({
    app: appPath,
    identity,
    platform: 'darwin',
    type: 'distribution',
    hardenedRuntime: true,
    timestamp: !forceUntimestampedLocalSign,
    strictVerify: true,
    // osx-sign's binary detector also classifies fonts and Office fixtures as
    // binary. Signing those wastes one timestamp request per asset and can
    // stall packaging for minutes. Keep only bundles, Mach-O libraries/native
    // modules, and executable sidecars.
    ignore: (filePath) => !isCodePath(filePath),
  })
  if (!verify(appPath)) throw new Error(`[mac-sign] repaired signature still fails: ${appPath}`)
  console.log('[mac-sign] embedded signature verified')
}
