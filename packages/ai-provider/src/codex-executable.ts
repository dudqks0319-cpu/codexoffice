import { chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const CODEX_SDK_VERSION = '0.146.0'

const PLATFORM_TARGETS: Record<string, { packageName: string; triple: string }> = {
  'darwin-arm64': {
    packageName: '@openai/codex-darwin-arm64',
    triple: 'aarch64-apple-darwin',
  },
  'darwin-x64': { packageName: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
  'linux-arm64': {
    packageName: '@openai/codex-linux-arm64',
    triple: 'aarch64-unknown-linux-musl',
  },
  'linux-x64': { packageName: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  'win32-arm64': {
    packageName: '@openai/codex-win32-arm64',
    triple: 'aarch64-pc-windows-msvc',
  },
  'win32-x64': {
    packageName: '@openai/codex-win32-x64',
    triple: 'x86_64-pc-windows-msvc',
  },
}

let configuredExecutable: string | undefined
let configuredCodexHome: string | undefined

function isExecutableFile(filePath: string): boolean {
  try {
    const file = statSync(filePath)
    return file.isFile() && (process.platform === 'win32' || (file.mode & 0o111) !== 0)
  } catch {
    return false
  }
}

/** Set only from trusted main-process packaging code; renderer values must never reach this API. */
export function configureCodexExecutable(executablePath: string | undefined): void {
  if (executablePath === undefined) {
    configuredExecutable = undefined
    return
  }
  if (!path.isAbsolute(executablePath) || !isExecutableFile(executablePath)) {
    throw new Error('The configured Codex executable must be an executable absolute file path')
  }
  configuredExecutable = executablePath
}

/**
 * Configure an app-private Codex home from trusted main-process packaging code.
 * Standalone development falls back to HOME/.codex only; arbitrary CODEX_HOME
 * environment values are deliberately ignored.
 */
export function configureCodexHome(homePath: string | undefined): void {
  if (homePath === undefined) {
    configuredCodexHome = undefined
    return
  }
  if (!path.isAbsolute(homePath)) {
    throw new Error('The configured Codex home must be an absolute path')
  }
  try {
    mkdirSync(homePath, { recursive: true, mode: 0o700 })
    chmodSync(homePath, 0o700)
    if (!statSync(homePath).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error('The configured Codex home could not be secured')
  }
  configuredCodexHome = homePath
}

/** Build the trusted executable path used by installers that copy vendor/ outside ASAR. */
export function packagedCodexExecutablePath(
  resourcesPath: string,
  platform = process.platform,
  architecture = process.arch,
): string {
  const targetPath = platform === 'win32' ? path.win32 : path.posix
  if (!targetPath.isAbsolute(resourcesPath)) {
    throw new Error('The packaged resources path must be absolute')
  }
  const target = PLATFORM_TARGETS[`${platform}-${architecture}`]
  if (!target) throw new Error(`Codex is not available on ${platform}/${architecture}`)
  return targetPath.join(
    resourcesPath,
    'codex',
    'vendor',
    target.triple,
    'bin',
    platform === 'win32' ? 'codex.exe' : 'codex',
  )
}

/** Resolve the exact SDK-native binary. Never falls back to PATH or a global Codex install. */
export function resolveCodexExecutable(): string {
  if (configuredExecutable) {
    if (!isExecutableFile(configuredExecutable)) {
      throw new Error('The configured packaged Codex executable is unavailable')
    }
    return configuredExecutable
  }

  const target = PLATFORM_TARGETS[`${process.platform}-${process.arch}`]
  if (!target) throw new Error(`Codex is not available on ${process.platform}/${process.arch}`)

  let codexPackageJson: string
  let platformPackageJson: string
  try {
    codexPackageJson = require.resolve('@openai/codex/package.json')
    const codexPackage = JSON.parse(readFileSync(codexPackageJson, 'utf8')) as { version?: unknown }
    if (codexPackage.version !== CODEX_SDK_VERSION) throw new Error('version mismatch')
    platformPackageJson = createRequire(codexPackageJson).resolve(
      `${target.packageName}/package.json`,
    )
    const platformPackage = JSON.parse(readFileSync(platformPackageJson, 'utf8')) as {
      version?: unknown
    }
    if (platformPackage.version !== `${CODEX_SDK_VERSION}-${process.platform}-${process.arch}`) {
      throw new Error('platform version mismatch')
    }
  } catch {
    throw new Error(
      `Unable to locate the exact Codex SDK ${CODEX_SDK_VERSION} native package for ${process.platform}/${process.arch}`,
    )
  }
  const executable = path.join(
    path.dirname(platformPackageJson),
    'vendor',
    target.triple,
    'bin',
    process.platform === 'win32' ? 'codex.exe' : 'codex',
  )
  if (!isExecutableFile(executable)) {
    throw new Error(
      `The Codex SDK native executable is missing for ${process.platform}/${process.arch}`,
    )
  }
  return executable
}

/** Keep credentials out of the child environment while retaining OS account-based login discovery. */
export function codexChildEnvironment(): Record<string, string> {
  const allowed = [
    'HOME',
    'USER',
    'LOGNAME',
    'PATH',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'SystemRoot',
    'WINDIR',
  ]
  const env: Record<string, string> = {}
  for (const key of allowed) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  const home = process.env.HOME
  if (configuredCodexHome) env.CODEX_HOME = configuredCodexHome
  else if (home) env.CODEX_HOME = path.join(home, '.codex')
  else throw new Error('Codex requires a configured app-private home')
  return env
}
