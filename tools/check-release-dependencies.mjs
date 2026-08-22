import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appNames = ['docs', 'pdf', 'sheets', 'shell', 'slides']
const patchedElectron = '41.10.3'
const minimumNode = '22.12.0'

function versionParts(value, label) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`[release-deps] invalid exact ${label} version: ${String(value)}`)
  }
  return value.split('.').map(Number)
}

function compareVersions(left, right, label) {
  const a = versionParts(left, label)
  const b = versionParts(right, label)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

export function checkReleaseDependencies(options = {}) {
  const repositoryRoot = options.repositoryRoot ?? root
  const environment = options.environment ?? process.env
  const nodeVersion = options.nodeVersion ?? process.versions.node
  const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
  const rootPackage = readJson(join(repositoryRoot, 'package.json'))
  const lock = readJson(join(repositoryRoot, 'package-lock.json'))
  const lockedElectron = lock.packages?.['node_modules/electron']?.version
  const lockedParts = versionParts(lockedElectron, 'Electron')
  const configuredNode = readFileSync(join(repositoryRoot, '.nvmrc'), 'utf8').trim()

  if (compareVersions(nodeVersion, minimumNode, 'Node') < 0) {
    throw new Error(
      `[release-deps] Node ${nodeVersion} is below the Electron release baseline ${minimumNode}`,
    )
  }
  if (compareVersions(configuredNode, minimumNode, 'Node') < 0) {
    throw new Error(
      `[release-deps] .nvmrc Node ${configuredNode} is below the Electron release baseline ${minimumNode}`,
    )
  }
  if (rootPackage.engines?.node !== `>=${minimumNode}`) {
    throw new Error(`[release-deps] root engines.node must be >=${minimumNode}`)
  }

  if (lockedParts[0] !== 41 || compareVersions(lockedElectron, patchedElectron, 'Electron') < 0) {
    throw new Error(
      `[release-deps] electron ${lockedElectron} is outside reviewed baseline 41.10.3+ (GHSA-9f4c-93c8-jc8g)`,
    )
  }
  if (rootPackage.devDependencies?.electron !== lockedElectron) {
    throw new Error(`[release-deps] root must pin electron exactly to ${lockedElectron}`)
  }

  for (const appName of appNames) {
    const declared = readJson(join(repositoryRoot, 'apps', appName, 'package.json')).devDependencies
      ?.electron
    if (declared !== lockedElectron) {
      throw new Error(
        `[release-deps] apps/${appName} must pin electron exactly to ${lockedElectron}`,
      )
    }
  }

  for (const relativePath of [
    'apps/docs/electron-builder.cjs',
    'apps/slides/electron-builder.cjs',
    'apps/shell/build/electron-builder-config.js',
  ]) {
    const source = readFileSync(join(repositoryRoot, relativePath), 'utf8')
    if (!source.includes(`electronVersion: '${lockedElectron}'`)) {
      throw new Error(`[release-deps] ${relativePath} does not match electron ${lockedElectron}`)
    }
  }

  for (const name of [
    'electron_use_remote_checksums',
    'npm_config_electron_use_remote_checksums',
    'ELECTRON_OVERRIDE_DIST_PATH',
  ]) {
    if (environment[name]) {
      throw new Error(`[release-deps] unsafe Electron artifact override is set: ${name}`)
    }
  }

  const installedVersion = readFileSync(
    join(repositoryRoot, 'node_modules', 'electron', 'dist', 'version'),
    'utf8',
  )
    .trim()
    .replace(/^v/, '')
  if (installedVersion !== lockedElectron) {
    throw new Error(
      `[release-deps] installed Electron ${installedVersion} does not match lock ${lockedElectron}`,
    )
  }

  return { electron: lockedElectron, node: nodeVersion }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = checkReleaseDependencies()
  console.log(`[release-deps] PASS electron ${result.electron}, node ${result.node}`)
}
