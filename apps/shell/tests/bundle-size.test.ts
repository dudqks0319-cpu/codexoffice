import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = resolve(__dirname, '../../../tools/check-macos-bundle-size.mjs')
const temporary: string[] = []

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'codexoffice-bundle-size-'))
  temporary.push(root)
  const app = join(root, 'Codexoffice.app')
  for (const directory of [
    'Contents/Frameworks/Electron Framework.framework',
    'Contents/Resources/codex',
    'Contents/Resources/modules',
    'Contents/Resources/native',
  ]) {
    mkdirSync(join(app, directory), { recursive: true })
  }
  writeFileSync(join(app, 'Contents/Frameworks/Electron Framework.framework/Electron'), 'electron')
  writeFileSync(join(app, 'Contents/Resources/codex/codex'), 'codex')
  writeFileSync(join(app, 'Contents/Resources/modules/docs.js'), 'docs')
  writeFileSync(join(app, 'Contents/Resources/native/xlsx-sidecar'), 'native')
  writeFileSync(join(app, 'Contents/Resources/app.asar'), 'shell')
  return app
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('macOS bundle size gate', () => {
  it('reports Electron, Codex, modules, native sidecars, and shell separately', () => {
    const output = execFileSync(process.execPath, [script, fixture(), '--json', '--enforce'], {
      encoding: 'utf8',
    })
    const report = JSON.parse(output) as {
      bytes: Record<string, number>
      failures: string[]
    }
    expect(report.failures).toEqual([])
    for (const component of ['app', 'electron', 'codex', 'modules', 'native', 'appAsar']) {
      expect(report.bytes[component]).toBeGreaterThan(0)
    }
  })

  it('fails closed when any configured release budget is exceeded', () => {
    expect(() =>
      execFileSync(process.execPath, [script, fixture(), '--enforce', '--max-codex-mib', '0'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow()
  })

  it('rejects non-app targets instead of reporting misleading data', () => {
    const root = mkdtempSync(join(tmpdir(), 'codexoffice-bundle-size-invalid-'))
    temporary.push(root)
    expect(() =>
      execFileSync(process.execPath, [script, root, '--json'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow()
  })

  it('fails closed when a required component is missing', () => {
    const app = fixture()
    rmSync(join(app, 'Contents/Resources/codex'), { recursive: true })
    expect(() =>
      execFileSync(process.execPath, [script, app, '--enforce'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow()
  })

  it('fails closed when a required component root is an external symlink', () => {
    const app = fixture()
    const external = mkdtempSync(join(tmpdir(), 'codexoffice-external-codex-'))
    temporary.push(external)
    writeFileSync(join(external, 'codex'), 'external')
    const codex = join(app, 'Contents/Resources/codex')
    rmSync(codex, { recursive: true })
    symlinkSync(external, codex)
    expect(() =>
      execFileSync(process.execPath, [script, app, '--enforce'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow()
  })

  it('keeps the bundle-size gate in the canonical macOS distribution command', () => {
    const rootPackage = JSON.parse(
      readFileSync(resolve(__dirname, '../../../package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    expect(rootPackage.scripts['dist:mac']).toMatch(/&& npm run audit:mac-bundle-size$/)
  })
})
