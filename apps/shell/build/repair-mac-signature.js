const { execFileSync } = require('node:child_process')
const { existsSync, statSync } = require('node:fs')
const { join } = require('node:path')
const { signAsync } = require('@electron/osx-sign')

function createRepairMacSignature(dependencies = {}) {
  const environment = dependencies.env ?? process.env
  const currentPlatform = dependencies.platform ?? process.platform
  const fileExists = dependencies.existsSync ?? existsSync
  const fileStat = dependencies.statSync ?? statSync
  const runFile = dependencies.execFileSync ?? execFileSync
  const signer = dependencies.signAsync ?? signAsync
  const warn = dependencies.warn ?? console.warn
  const log = dependencies.log ?? console.log

  function verify(appPath) {
    try {
      runFile('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], {
        stdio: 'ignore',
      })
      return true
    } catch {
      return false
    }
  }

  function isCodePath(filePath) {
    if (/\.(?:app|framework|xpc|dylib|node)$/i.test(filePath)) return true
    try {
      return fileStat(filePath).isFile() && (fileStat(filePath).mode & 0o111) !== 0
    } catch {
      return false
    }
  }

  return async function repairMacSignature(context) {
    if (currentPlatform !== 'darwin') return
    const appName = context.packager.appInfo.productFilename
    const appPath = join(context.appOutDir, `${appName}.app`)
    if (!fileExists(appPath)) return
    const builderIdentity = context.packager.platformSpecificBuildOptions?.identity
    if (
      environment.CSC_IDENTITY_AUTO_DISCOVERY === 'false' ||
      builderIdentity === null ||
      environment.GENOFFICE_SIGNING_AUTHORIZED !== '1'
    ) {
      warn('[mac-sign] signing not authorized; leaving local package unsigned')
      return
    }
    const identity =
      (typeof builderIdentity === 'string' && builderIdentity.trim()) ||
      (typeof environment.CSC_NAME === 'string' && environment.CSC_NAME.trim())
    const timestampMode = environment.GENOFFICE_SIGNING_TIMESTAMP_MODE
    const forceUntimestampedLocalSign =
      timestampMode === 'none' && environment.GENOFFICE_LOCAL_UNTIMESTAMPED_SIGN === '1'
    if (
      !identity ||
      (timestampMode !== 'secure' && timestampMode !== 'none') ||
      (timestampMode === 'none' && !forceUntimestampedLocalSign)
    ) {
      warn('[mac-sign] signing prerequisites unavailable; leaving local package unsigned')
      return
    }
    if (!forceUntimestampedLocalSign && verify(appPath)) return

    warn(
      forceUntimestampedLocalSign
        ? `[mac-sign] applying local untimestamped signature for ${appName}`
        : `[mac-sign] repairing embedded signature for ${appName}`,
    )
    await signer({
      app: appPath,
      identity,
      platform: 'darwin',
      type: 'distribution',
      hardenedRuntime: true,
      optionsForFile: () => ({
        timestamp: forceUntimestampedLocalSign ? 'none' : true,
        hardenedRuntime: true,
      }),
      strictVerify: true,
      ignore: (filePath) => !isCodePath(filePath),
    })
    if (!verify(appPath)) throw new Error(`[mac-sign] repaired signature still fails: ${appPath}`)
    log('[mac-sign] embedded signature verified')
  }
}

exports.createRepairMacSignature = createRepairMacSignature
exports.default = createRepairMacSignature()
