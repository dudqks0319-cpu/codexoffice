import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  codexChildEnvironment,
  configureCodexExecutable,
  configureCodexHome,
  packagedCodexExecutablePath,
  resolveCodexExecutable,
} from '../src/codex-executable'

afterEach(() => {
  configureCodexHome(undefined)
  configureCodexExecutable(undefined)
  vi.unstubAllEnvs()
})

describe('Codex home isolation', () => {
  it('uses the trusted app-private home, creates it, and secures it to 0700', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-home-test-'))
    const appHome = path.join(root, 'app-codex')
    try {
      vi.stubEnv('CODEX_HOME', '/renderer-controlled/home')
      configureCodexHome(appHome)
      expect(codexChildEnvironment().CODEX_HOME).toBe(appHome)
      expect((await stat(appHome)).mode & 0o777).toBe(0o700)
    } finally {
      configureCodexHome(undefined)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ignores process CODEX_HOME in standalone development fallback', () => {
    vi.stubEnv('HOME', '/trusted-user-home')
    vi.stubEnv('CODEX_HOME', '/renderer-controlled/home')
    expect(codexChildEnvironment().CODEX_HOME).toBe('/trusted-user-home/.codex')
  })

  it('rejects a relative configured home', () => {
    expect(() => configureCodexHome('relative/codex')).toThrow('absolute path')
  })

  it('honors a trusted packaged executable override', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-bin-test-'))
    const executable = path.join(root, process.platform === 'win32' ? 'codex.exe' : 'codex')
    try {
      await writeFile(executable, '')
      if (process.platform !== 'win32') await chmod(executable, 0o755)
      configureCodexExecutable(executable)
      expect(resolveCodexExecutable()).toBe(executable)
    } finally {
      configureCodexExecutable(undefined)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('builds platform-specific paths only below an absolute packaged resources directory', () => {
    expect(
      packagedCodexExecutablePath('/Applications/Test.app/Contents/Resources', 'darwin', 'arm64'),
    ).toBe('/Applications/Test.app/Contents/Resources/codex/vendor/aarch64-apple-darwin/bin/codex')
    expect(
      packagedCodexExecutablePath('C:\\Program Files\\Test\\resources', 'win32', 'x64'),
    ).toMatch(/codex[\\/]vendor[\\/]x86_64-pc-windows-msvc[\\/]bin[\\/]codex\.exe$/)
    expect(() => packagedCodexExecutablePath('relative/resources')).toThrow('must be absolute')
    expect(() => packagedCodexExecutablePath('/resources', 'freebsd', 'x64')).toThrow(
      'not available',
    )
  })

  it('resolves an executable from the exact installed SDK native dependency', async () => {
    const executable = resolveCodexExecutable()
    expect(path.isAbsolute(executable)).toBe(true)
    expect((await stat(executable)).isFile()).toBe(true)
  })
})
