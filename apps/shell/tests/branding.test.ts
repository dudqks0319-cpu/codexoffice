import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../../..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

describe('Codexoffice product metadata', () => {
  it.each([
    ['apps/shell/package.json', 'Codexoffice'],
    ['apps/docs/package.json', 'Codexoffice Docs'],
    ['apps/sheets/package.json', 'Codexoffice Sheets'],
    ['apps/slides/package.json', 'Codexoffice Slides'],
    ['apps/pdf/package.json', 'Codexoffice PDF'],
  ])('%s exposes %s as its product name', (path, expected) => {
    expect(JSON.parse(read(path)).productName).toBe(expected)
  })

  it.each([
    [
      'apps/shell/electron-builder.cjs',
      'com.genoffice.app',
      'Codexoffice-${version}-${arch}.${ext}',
    ],
    [
      'apps/docs/electron-builder.cjs',
      'com.genoffice.docs',
      'Codexoffice-Docs-${version}-${arch}.${ext}',
    ],
    [
      'apps/slides/electron-builder.cjs',
      'com.genoffice.slides',
      'Codexoffice-Slides-${version}-${arch}.${ext}',
    ],
  ])('%s keeps its update identity and brands its artifact', (path, appId, artifact) => {
    const config = read(path)
    expect(config).toContain(`appId: '${appId}'`)
    expect(config).toContain(`artifactName: '${artifact}'`)
  })

  it('uses the neutral application icon with a text product name on Home', () => {
    const home = read('apps/shell/src/renderer/src/Home.tsx')
    expect(home).toContain("import appIcon from './assets/app-icon.png'")
    expect(home).toContain('Codexoffice</span>')
    expect(home).not.toContain('genoffice-logo')
  })

  it('discloses the independent publisher boundary before Codex sign-in', () => {
    const onboarding = read('apps/shell/src/renderer/src/Onboarding.tsx')
    expect(onboarding).toContain('Independent open-source project; not an OpenAI product.')
    expect(onboarding).toContain('독립 오픈소스 프로젝트이며 OpenAI 제품이 아닙니다.')
    expect(onboarding).toContain('INDEPENDENT_PROJECT_NOTICE[lang]')
  })

  it('preserves installed identities and existing user data paths', () => {
    const shellMain = read('apps/shell/src/main/index.ts')
    expect(shellMain).toContain("const userData = userDataOverride ?? join(appData, 'GenOffice')")
    expect(shellMain).toMatch(
      /const userDataOverride\s*=\s*requestedUserData && allowPackagedUserDataOverride && isAbsolute\(requestedUserData\)\s*\?/,
    )
    expect(shellMain).toContain("process.env.GENOFFICE_PACKAGED_SMOKE === '1'")
    expect(shellMain).toContain("const olderUserData = join(appData, 'AI Office')")
    expect(shellMain).toContain("app.setPath('userData', userData)")
    expect(shellMain).toContain('readdirSync(userData).length === 0')
    expect(shellMain).toContain('cpSync(olderUserData, userData, { recursive: true })')
    expect(shellMain).toContain('if (!userDataOverride)')
    expect(read('apps/docs/src/main/docs-main.ts')).toContain("'GenOffice Docs'")
    expect(read('apps/sheets/src/main/sheets-main.ts')).toContain("'GenOffice Sheets'")
    expect(read('apps/slides/src/main/slides-main.ts')).toContain("'GenOffice Slides'")
    expect(read('apps/pdf/src/main/pdf-main.ts')).toContain("'GenOffice PDF'")
  })

  it('uses Codexoffice names for every File > New product label', () => {
    const shellMain = read('apps/shell/src/main/index.ts')
    expect(shellMain).not.toMatch(/menuNew(?:Doc|Sheet|Slide): 'AI (?:Docs|Sheets|Slides)'/)
    expect(shellMain.match(/menuNewDoc: 'Codexoffice Docs'/g)).toHaveLength(19)
    expect(shellMain.match(/menuNewSheet: 'Codexoffice Sheets'/g)).toHaveLength(19)
    expect(shellMain.match(/menuNewSlide: 'Codexoffice Slides'/g)).toHaveLength(19)
  })
})
