const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

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

exports.default = function repairMacSignature(context) {
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
  const args = ['--force', '--deep', '--options', 'runtime']
  if (!forceUntimestampedLocalSign) args.push('--timestamp')
  args.push('--sign', identity, appPath)
  execFileSync(
    '/usr/bin/codesign',
    args,
    { stdio: 'inherit' },
  )
  if (!verify(appPath)) throw new Error(`[mac-sign] repaired signature still fails: ${appPath}`)
  console.log('[mac-sign] embedded signature verified')
}
