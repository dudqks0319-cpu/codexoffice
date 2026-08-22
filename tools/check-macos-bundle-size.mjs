import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const MIB = 1024 * 1024

export const DEFAULT_MACOS_BUNDLE_BUDGET_MIB = Object.freeze({
  app: 720,
  electron: 280,
  codex: 330,
  modules: 96,
})

async function allocatedBytes(filePath) {
  const info = await lstat(filePath)
  if (info.isSymbolicLink()) return 0
  if (!info.isDirectory()) return info.blocks * 512
  const entries = await readdir(filePath)
  const sizes = await Promise.all(entries.map((entry) => allocatedBytes(join(filePath, entry))))
  return sizes.reduce((total, size) => total + size, 0)
}

async function requiredComponentBytes(appPath, componentPath, expectedType) {
  const info = await lstat(componentPath).catch(() => null)
  if (
    !info ||
    info.isSymbolicLink() ||
    (expectedType === 'directory' ? !info.isDirectory() : !info.isFile())
  ) {
    throw new Error(`bundle-size: required ${expectedType} is missing or unsafe: ${componentPath}`)
  }
  const [canonicalApp, canonicalComponent] = await Promise.all([
    realpath(appPath),
    realpath(componentPath),
  ])
  const inside = relative(canonicalApp, canonicalComponent)
  if (inside === '' || inside === '..' || inside.startsWith('../') || inside.startsWith('..\\')) {
    throw new Error(`bundle-size: required component escapes the app bundle: ${componentPath}`)
  }
  const bytes = await allocatedBytes(componentPath)
  if (bytes <= 0) throw new Error(`bundle-size: required component is empty: ${componentPath}`)
  return bytes
}

export async function inspectMacosBundle(appPath) {
  const absolutePath = resolve(appPath)
  const info = await lstat(absolutePath)
  if (!info.isDirectory() || !absolutePath.endsWith('.app')) {
    throw new Error('bundle-size: expected a macOS .app directory')
  }
  const contents = join(absolutePath, 'Contents')
  const [app, electron, codex, modules, native, appAsar] = await Promise.all([
    allocatedBytes(absolutePath),
    requiredComponentBytes(
      absolutePath,
      join(contents, 'Frameworks', 'Electron Framework.framework'),
      'directory',
    ),
    requiredComponentBytes(absolutePath, join(contents, 'Resources', 'codex'), 'directory'),
    requiredComponentBytes(absolutePath, join(contents, 'Resources', 'modules'), 'directory'),
    requiredComponentBytes(absolutePath, join(contents, 'Resources', 'native'), 'directory'),
    requiredComponentBytes(absolutePath, join(contents, 'Resources', 'app.asar'), 'file'),
  ])
  return {
    schemaVersion: 1,
    appPath: absolutePath,
    bytes: { app, electron, codex, modules, native, appAsar },
    mib: Object.fromEntries(
      Object.entries({ app, electron, codex, modules, native, appAsar }).map(([key, value]) => [
        key,
        Number((value / MIB).toFixed(1)),
      ]),
    ),
  }
}

export function evaluateMacosBundleBudget(report, budgetMib = DEFAULT_MACOS_BUNDLE_BUDGET_MIB) {
  const failures = []
  for (const key of ['app', 'electron', 'codex', 'modules']) {
    const actual = report.bytes[key]
    const maximum = budgetMib[key] * MIB
    if (!Number.isFinite(maximum) || maximum < 0) {
      throw new Error(`bundle-size: invalid ${key} budget`)
    }
    if (actual > maximum) {
      failures.push(`${key}: ${report.mib[key]} MiB > ${budgetMib[key]} MiB`)
    }
  }
  return failures
}

function parseArguments(argv) {
  const options = {
    appPath: undefined,
    enforce: false,
    json: false,
    budgetMib: { ...DEFAULT_MACOS_BUNDLE_BUDGET_MIB },
  }
  const budgetFlags = {
    '--max-app-mib': 'app',
    '--max-electron-mib': 'electron',
    '--max-codex-mib': 'codex',
    '--max-modules-mib': 'modules',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--enforce') options.enforce = true
    else if (value === '--json') options.json = true
    else if (budgetFlags[value]) {
      const parsed = Number(argv[index + 1])
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`bundle-size: ${value} requires a non-negative number`)
      }
      options.budgetMib[budgetFlags[value]] = parsed
      index += 1
    } else if (value.startsWith('--')) {
      throw new Error(`bundle-size: unknown option ${value}`)
    } else if (options.appPath === undefined) options.appPath = value
    else throw new Error('bundle-size: only one app path is allowed')
  }
  options.appPath ??= 'apps/shell/release/mac-arm64/Codexoffice.app'
  return options
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const report = await inspectMacosBundle(options.appPath)
  const failures = evaluateMacosBundleBudget(report, options.budgetMib)
  if (options.json)
    console.log(JSON.stringify({ ...report, budgetMib: options.budgetMib, failures }))
  else {
    console.log(`Codexoffice bundle: ${report.mib.app} MiB`)
    console.log(`  Electron: ${report.mib.electron} MiB`)
    console.log(`  Codex runtime: ${report.mib.codex} MiB`)
    console.log(`  Office modules: ${report.mib.modules} MiB`)
    console.log(`  Native sidecars: ${report.mib.native} MiB`)
    console.log(`  Shell ASAR: ${report.mib.appAsar} MiB`)
  }
  if (options.enforce && failures.length > 0) {
    throw new Error(`bundle-size: budget exceeded\n${failures.join('\n')}`)
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
