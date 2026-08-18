const { existsSync, readFileSync, statSync } = require('node:fs')
const { join } = require('node:path')

const REPO_ROOT = join(__dirname, '..')
const CODEX_VERSION = '0.146.0'

const CODEX_TARGETS = {
  'darwin-arm64': {
    packageName: '@openai/codex-darwin-arm64',
    triple: 'aarch64-apple-darwin',
  },
  'darwin-x64': {
    packageName: '@openai/codex-darwin-x64',
    triple: 'x86_64-apple-darwin',
  },
  'win32-x64': {
    packageName: '@openai/codex-win32-x64',
    triple: 'x86_64-pc-windows-msvc',
  },
}

function resolveCodexBuildRuntimeForTarget(
  platform,
  architecture,
  { repoRoot = REPO_ROOT, exists = existsSync, readFile = readFileSync, stat = statSync } = {},
) {
  if (platform === 'win32' && architecture !== 'x64') {
    throw new Error('The Windows installer currently supports x64 only')
  }

  const target = CODEX_TARGETS[`${platform}-${architecture}`]
  if (!target) {
    throw new Error(`Unsupported Codex packaging target: ${platform}-${architecture}`)
  }
  const packageRoot = join(repoRoot, 'node_modules', target.packageName)
  const packageJsonPath = join(packageRoot, 'package.json')
  const vendorSource = join(packageRoot, 'vendor')
  const executable = join(
    vendorSource,
    target.triple,
    'bin',
    platform === 'win32' ? 'codex.exe' : 'codex',
  )
  let validRuntime
  try {
    const packageJson = JSON.parse(readFile(packageJsonPath, 'utf8'))
    const executableStat = stat(executable)
    validRuntime =
      packageJson.version === `${CODEX_VERSION}-${platform}-${architecture}` &&
      executableStat.isFile() &&
      (platform === 'win32' || (executableStat.mode & 0o111) !== 0)
  } catch {
    validRuntime = false
  }
  if (!validRuntime || !exists(vendorSource)) {
    throw new Error(
      `electron-builder Codex ${CODEX_VERSION} runtime missing or invalid: ${packageRoot} (run npm ci on the target platform)`,
    )
  }
  return { packageName: target.packageName, vendorSource, executable }
}

function resolveCodexBuildRuntime({
  argv = process.argv,
  lifecycle = process.env.npm_lifecycle_event,
  platform = process.platform,
  architecture = process.arch,
  runtimeDependencies,
} = {}) {
  const requestedPlatforms = new Set()
  if (argv.includes('--mac') || lifecycle === 'dist:mac') requestedPlatforms.add('darwin')
  if (argv.includes('--win') || lifecycle === 'dist:win') requestedPlatforms.add('win32')
  if (argv.includes('--linux')) requestedPlatforms.add('linux')
  if (requestedPlatforms.size > 1) {
    throw new Error('Build installers for each platform in separate, host-native jobs')
  }

  const requestedPlatform = [...requestedPlatforms][0] ?? platform
  const requestedArchitectures = ['arm64', 'x64', 'universal'].filter((arch) =>
    argv.includes(`--${arch}`),
  )
  if (requestedArchitectures.length > 1 || requestedArchitectures[0] === 'universal') {
    throw new Error('Codex packaging supports one native architecture per installer')
  }
  const requestedArchitecture =
    requestedArchitectures[0] ?? (requestedPlatform === 'win32' ? 'x64' : architecture)

  if (requestedPlatform !== platform || requestedArchitecture !== architecture) {
    throw new Error(
      `Codex installers must be built on their target host/architecture (host ${platform}-${architecture}, requested ${requestedPlatform}-${requestedArchitecture})`,
    )
  }
  return resolveCodexBuildRuntimeForTarget(
    requestedPlatform,
    requestedArchitecture,
    runtimeDependencies,
  )
}

function codexExtraResource(options) {
  return {
    from: resolveCodexBuildRuntime(options).vendorSource,
    to: 'codex/vendor',
  }
}

module.exports = {
  codexExtraResource,
  resolveCodexBuildRuntime,
  resolveCodexBuildRuntimeForTarget,
}
