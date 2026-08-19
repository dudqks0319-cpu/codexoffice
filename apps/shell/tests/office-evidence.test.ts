import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { verifyMicrosoftOfficeEvidence } from '../../../tools/check-microsoft-office-evidence.mjs'

let evidenceRoot = ''
const sourceSha = '0123456789abcdef0123456789abcdef01234567'
const now = Date.parse('2026-08-19T01:00:00.000Z')
const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function verify(manifestPath: string, expectedSourceSha = sourceSha) {
  return verifyMicrosoftOfficeEvidence(manifestPath, { expectedSourceSha, now })
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function evidenceFile(name: string, value: string | Buffer = name) {
  writeFileSync(join(evidenceRoot, name), value)
  return { path: name, sha256: digest(value) }
}

function dmgFixture() {
  const bytes = Buffer.alloc(512)
  bytes.write('koly', 0, 'ascii')
  return bytes
}

function applicationEvidence(appName: 'word' | 'excel' | 'powerpoint') {
  const extensions = { word: '.docx', excel: '.xlsx', powerpoint: '.pptx' }
  const assertionSets = {
    word: {
      noRepairPrompt: true,
      referencesPreserved: true,
      bidirectionalEditsPreserved: true,
      layoutReviewed: true,
    },
    excel: {
      noRepairPrompt: true,
      formulasPreserved: true,
      chartsPreserved: true,
      stylesReviewed: true,
    },
    powerpoint: {
      noRepairPrompt: true,
      mastersPreserved: true,
      mediaPreserved: true,
      visualLayoutReviewed: true,
    },
  }
  return {
    status: 'PASS',
    version: `${appName} fixture version 1`,
    fixture: evidenceFile(
      `${appName}-input${extensions[appName]}`,
      Buffer.concat([zipHeader, Buffer.from(`${appName}-input`)]),
    ),
    savedDocument: evidenceFile(
      `${appName}-saved${extensions[appName]}`,
      Buffer.concat([zipHeader, Buffer.from(`${appName}-saved`)]),
    ),
    screenshots: [1, 2, 3].map((index) =>
      evidenceFile(
        `${appName}-screenshot-${index}.png`,
        Buffer.concat([pngHeader, Buffer.from(`${appName}-${index}`)]),
      ),
    ),
    assertions: assertionSets[appName],
  }
}

function validManifest() {
  evidenceRoot = mkdtempSync(join(tmpdir(), 'genoffice-office-evidence-'))
  const manifest = {
    schemaVersion: 2,
    sourceSha,
    testedAt: '2026-08-13T00:00:00.000Z',
    macosVersion: 'macOS fixture',
    architecture: 'arm64',
    releaseArtifact: evidenceFile('Codexoffice.dmg', dmgFixture()),
    office: {
      word: applicationEvidence('word'),
      excel: applicationEvidence('excel'),
      powerpoint: applicationEvidence('powerpoint'),
    },
  }
  const manifestPath = join(evidenceRoot, 'microsoft-office.json')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  return { manifest, manifestPath }
}

afterEach(() => {
  if (evidenceRoot) rmSync(evidenceRoot, { recursive: true, force: true })
  evidenceRoot = ''
})

describe('Microsoft Office evidence verifier', () => {
  it('verifies a complete source-bound and digest-bound evidence packet', () => {
    const { manifestPath } = validManifest()
    expect(verify(manifestPath)).toEqual({
      sourceSha,
      testedAt: '2026-08-13T00:00:00.000Z',
      status: 'PASS',
    })
  })

  it('rejects modified evidence bytes', () => {
    const { manifest, manifestPath } = validManifest()
    writeFileSync(
      join(evidenceRoot, manifest.office.excel.savedDocument.path),
      Buffer.concat([zipHeader, Buffer.from('tampered')]),
    )
    expect(() => verify(manifestPath)).toThrow(/digest mismatch/)
  })

  it('rejects incomplete manual assertions', () => {
    const { manifest, manifestPath } = validManifest()
    manifest.office.powerpoint.assertions.mediaPreserved = false
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => verify(manifestPath)).toThrow(/assertion is incomplete: mediaPreserved/)
  })

  it('rejects paths that escape the evidence directory', () => {
    const { manifest, manifestPath } = validManifest()
    manifest.office.word.fixture.path = '../outside.docx'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => verify(manifestPath)).toThrow(/leaves evidence root/)
  })

  it('rejects symlinked evidence even when the target bytes match', () => {
    const { manifest, manifestPath } = validManifest()
    const descriptor = manifest.office.word.savedDocument
    const original = join(evidenceRoot, descriptor.path)
    const target = join(evidenceRoot, 'word-saved-target.bin')
    writeFileSync(target, readFileSync(original))
    rmSync(original)
    symlinkSync(target, original)
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => verify(manifestPath)).toThrow(/not a regular file/)
  })

  it('rejects a symlinked manifest before parsing it', () => {
    const { manifestPath } = validManifest()
    const target = join(evidenceRoot, 'manifest-target.json')
    writeFileSync(target, readFileSync(manifestPath))
    rmSync(manifestPath)
    symlinkSync(target, manifestPath)
    expect(() => verify(manifestPath)).toThrow(/missing, unsafe, empty, or oversized/)
  })

  it('rejects evidence for a different release source', () => {
    const { manifestPath } = validManifest()
    expect(() => verify(manifestPath, 'fedcba9876543210fedcba9876543210fedcba98')).toThrow(
      /does not match expected release source/,
    )
  })

  it('rejects repeated screenshots masquerading as three observations', () => {
    const { manifest, manifestPath } = validManifest()
    manifest.office.excel.screenshots = [
      manifest.office.excel.screenshots[0],
      manifest.office.excel.screenshots[0],
      manifest.office.excel.screenshots[0],
    ]
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => verify(manifestPath)).toThrow(/path is duplicated/)
  })

  it('rejects canonical path aliases and files disguised by an Office extension', () => {
    const { manifest, manifestPath } = validManifest()
    const first = manifest.office.word.screenshots[0]
    const second = manifest.office.word.screenshots[1]
    manifest.office.word.screenshots[1] = { ...first, path: `./${first.path}` }
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => verify(manifestPath)).toThrow(/path is duplicated/)

    manifest.office.word.screenshots[1] = second
    const screenshot = manifest.office.powerpoint.screenshots[0]
    writeFileSync(join(evidenceRoot, screenshot.path), 'not an image')
    screenshot.sha256 = digest('not an image')
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => verify(manifestPath)).toThrow(/is not a PNG or JPEG image/)
  })

  it('rejects stale, unknown, and oversized evidence before release approval', () => {
    const { manifest, manifestPath } = validManifest()
    manifest.testedAt = '2026-06-01T00:00:00.000Z'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => verify(manifestPath)).toThrow(/testedAt is invalid, in the future, or stale/)

    manifest.testedAt = '2026-08-13T00:00:00.000Z'
    const unsafe = manifest as typeof manifest & { accountToken?: string }
    unsafe.accountToken = 'must-not-enter-evidence'
    writeFileSync(manifestPath, JSON.stringify(unsafe))
    expect(() => verify(manifestPath)).toThrow(/unknown field: accountToken/)

    delete unsafe.accountToken
    const screenshot = manifest.office.word.screenshots[0]
    truncateSync(join(evidenceRoot, screenshot.path), 20 * 1024 * 1024 + 1)
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => verify(manifestPath)).toThrow(/screenshot 1 is empty or oversized/)
  })

  it('requires the Office-authored document bytes to differ from the fixture', () => {
    const { manifest, manifestPath } = validManifest()
    const fixture = manifest.office.excel.fixture
    const saved = manifest.office.excel.savedDocument
    writeFileSync(join(evidenceRoot, saved.path), readFileSync(join(evidenceRoot, fixture.path)))
    saved.sha256 = fixture.sha256
    writeFileSync(manifestPath, JSON.stringify(manifest))

    expect(() => verify(manifestPath)).toThrow(/fixture and saved document must differ/)
  })
})
