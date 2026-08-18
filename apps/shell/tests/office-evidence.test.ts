import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { verifyMicrosoftOfficeEvidence } from '../../../tools/check-microsoft-office-evidence.mjs'

let evidenceRoot = ''
const sourceSha = '0123456789abcdef0123456789abcdef01234567'

function verify(manifestPath: string, expectedSourceSha = sourceSha) {
  return verifyMicrosoftOfficeEvidence(manifestPath, { expectedSourceSha })
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function evidenceFile(name: string, value = name) {
  writeFileSync(join(evidenceRoot, name), value)
  return { path: name, sha256: digest(value) }
}

function applicationEvidence(appName: 'word' | 'excel' | 'powerpoint') {
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
    fixture: evidenceFile(`${appName}-input.bin`),
    savedDocument: evidenceFile(`${appName}-saved.bin`),
    screenshots: [1, 2, 3].map((index) => evidenceFile(`${appName}-screenshot-${index}.png`)),
    assertions: assertionSets[appName],
  }
}

function validManifest() {
  evidenceRoot = mkdtempSync(join(tmpdir(), 'genoffice-office-evidence-'))
  const manifest = {
    schemaVersion: 1,
    sourceSha,
    testedAt: '2026-08-13T00:00:00.000Z',
    macosVersion: 'macOS fixture',
    releaseArtifact: evidenceFile('Codexoffice.dmg'),
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
    writeFileSync(join(evidenceRoot, manifest.office.excel.savedDocument.path), 'tampered')
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
    expect(() => verify(manifestPath)).toThrow(/missing, unsafe, or oversized/)
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
    expect(() => verify(manifestPath)).toThrow(/screenshots must be distinct/)
  })
})
