import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { checkReleaseDependencies } from '../../../tools/check-release-dependencies.mjs'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const releaseNodeVersion = '22.23.2'
let fixtureRoot = ''

function check(repositoryRoot: string, environment: NodeJS.ProcessEnv = {}) {
  return checkReleaseDependencies({ repositoryRoot, environment, nodeVersion: releaseNodeVersion })
}

function fixture(version: string): string {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'genoffice-release-deps-'))
  const lock = JSON.parse(readFileSync(join(repositoryRoot, 'package-lock.json'), 'utf8'))
  lock.packages['node_modules/electron'].version = version
  writeFileSync(join(fixtureRoot, 'package-lock.json'), JSON.stringify(lock))
  const rootPackage = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
  rootPackage.devDependencies.electron = version
  writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify(rootPackage))
  writeFileSync(join(fixtureRoot, '.nvmrc'), releaseNodeVersion)
  for (const appName of ['docs', 'pdf', 'sheets', 'shell', 'slides']) {
    const destination = join(fixtureRoot, 'apps', appName)
    mkdirSync(destination, { recursive: true })
    const packageJson = JSON.parse(
      readFileSync(join(repositoryRoot, 'apps', appName, 'package.json'), 'utf8'),
    )
    packageJson.devDependencies.electron = version
    writeFileSync(join(destination, 'package.json'), JSON.stringify(packageJson))
  }
  for (const relativePath of [
    'apps/docs/electron-builder.cjs',
    'apps/slides/electron-builder.cjs',
    'apps/shell/build/electron-builder-config.js',
  ]) {
    const destination = join(fixtureRoot, relativePath)
    mkdirSync(join(destination, '..'), { recursive: true })
    const source = readFileSync(join(repositoryRoot, relativePath), 'utf8').replace(
      /electronVersion: '\d+\.\d+\.\d+'/,
      `electronVersion: '${version}'`,
    )
    writeFileSync(destination, source)
  }
  const dist = join(fixtureRoot, 'node_modules', 'electron', 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'version'), version)
  return fixtureRoot
}

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = ''
})

describe('release dependency gate', () => {
  it('accepts one exact patched Electron across the lock, apps, builders, and binary', () => {
    expect(check(fixture('41.10.3'))).toEqual({ electron: '41.10.3', node: releaseNodeVersion })
  })

  it('rejects Node 20 before packaging even when the Electron pin is patched', () => {
    expect(() =>
      checkReleaseDependencies({
        repositoryRoot: fixture('41.10.3'),
        environment: {},
        nodeVersion: '20.20.2',
      }),
    ).toThrow(/below the Electron release baseline 22\.12\.0/)
  })

  it('rejects a stale repository Node baseline', () => {
    const root = fixture('41.10.3')
    writeFileSync(join(root, '.nvmrc'), '20.20.2')
    expect(() => check(root)).toThrow(/\.nvmrc Node 20\.20\.2 is below/)
  })

  it('rejects the audited vulnerable Electron before packaging', () => {
    expect(() => check(fixture('41.7.1'))).toThrow(/outside reviewed baseline 41\.10\.3/)
  })

  it('rejects an unreviewed major even when its number sorts above 41', () => {
    expect(() => check(fixture('42.0.0'))).toThrow(/outside reviewed baseline 41\.10\.3/)
  })

  it('rejects an unpinned app declaration', () => {
    const root = fixture('41.10.3')
    const path = join(root, 'apps', 'pdf', 'package.json')
    const packageJson = JSON.parse(readFileSync(path, 'utf8'))
    packageJson.devDependencies.electron = '^41.0.3'
    writeFileSync(path, JSON.stringify(packageJson))
    expect(() => check(root)).toThrow(/must pin electron exactly/)
  })

  it('rejects an unpinned root Electron declaration', () => {
    const root = fixture('41.10.3')
    const path = join(root, 'package.json')
    const packageJson = JSON.parse(readFileSync(path, 'utf8'))
    packageJson.devDependencies.electron = '^41.10.3'
    writeFileSync(path, JSON.stringify(packageJson))
    expect(() => check(root)).toThrow(/root must pin electron exactly/)
  })

  it('rejects checksum and binary-path overrides', () => {
    const root = fixture('41.10.3')
    for (const name of [
      'electron_use_remote_checksums',
      'npm_config_electron_use_remote_checksums',
      'ELECTRON_OVERRIDE_DIST_PATH',
    ]) {
      expect(() => check(root, { [name]: '1' })).toThrow(/unsafe Electron artifact override/)
    }
  })

  it('rejects a stale installed Electron binary', () => {
    const root = fixture('41.10.3')
    writeFileSync(join(root, 'node_modules', 'electron', 'dist', 'version'), '41.7.1')
    expect(() => check(root)).toThrow(/does not match lock/)
  })
})
