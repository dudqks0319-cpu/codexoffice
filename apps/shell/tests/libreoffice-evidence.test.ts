import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { verifyLibreOfficeEvidence } from '../../../tools/check-libreoffice-evidence.mjs'

const sourceSha = '0123456789abcdef0123456789abcdef01234567'
const now = Date.parse('2026-08-19T01:00:00.000Z')
const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
let evidenceRoot = ''

function releaseIdentity() {
  return {
    schemaVersion: 1,
    productName: 'Codexoffice',
    appId: 'com.genoffice.app',
    version: '0.5.0',
    sourceSha,
    packagePayload: {
      path: 'Contents/Resources/app.asar',
      sha256: digest('app-asar'),
    },
  }
}

function releaseArchive() {
  return { identity: releaseIdentity(), payloadSha256: digest('app-asar') }
}

function verify(manifestPath: string, expectedSourceSha = sourceSha) {
  return verifyLibreOfficeEvidence(manifestPath, {
    expectedSourceSha,
    now,
    inspectReleaseZip: releaseArchive,
  })
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function evidenceFile(name: string, value: string | Buffer = name) {
  writeFileSync(join(evidenceRoot, name), value)
  return { path: name, sha256: digest(value) }
}

function zipFixture() {
  return Buffer.concat([zipHeader, Buffer.from('release-fixture')])
}

function makeAppEvidence(appName: 'writer' | 'calc' | 'impress') {
  const extensions = { writer: '.docx', calc: '.xlsx', impress: '.pptx' }
  const assertionSets = {
    writer: {
      noRepairPrompt: true,
      footnotesPreserved: true,
      bidirectionalEditsPreserved: true,
      visualLayoutReviewed: true,
    },
    calc: {
      noRepairPrompt: true,
      formulasPreserved: true,
      chartsPreserved: true,
      visualLayoutReviewed: true,
    },
    impress: {
      noRepairPrompt: true,
      mastersPreserved: true,
      mediaPreserved: true,
      visualLayoutReviewed: true,
    },
  }
  return {
    status: 'PASS',
    version: `LibreOffice ${appName} fixture`,
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
        `${appName}-${index}.png`,
        Buffer.concat([pngHeader, Buffer.from(`${appName}-${index}`)]),
      ),
    ),
    assertions: assertionSets[appName],
  }
}

function validManifest() {
  evidenceRoot = mkdtempSync(join(tmpdir(), 'genoffice-libreoffice-evidence-'))
  const manifest = {
    schemaVersion: 2,
    sourceSha,
    testedAt: '2026-08-19T00:00:00.000Z',
    macosVersion: 'macOS fixture',
    architecture: 'arm64',
    releaseArtifact: evidenceFile('Codexoffice.zip', zipFixture()),
    structuralCorpusPassed: true,
    libreoffice: {
      writer: makeAppEvidence('writer'),
      calc: makeAppEvidence('calc'),
      impress: makeAppEvidence('impress'),
    },
  }
  const manifestPath = join(evidenceRoot, 'libreoffice.json')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  return { manifest, manifestPath }
}

afterEach(() => {
  if (evidenceRoot) rmSync(evidenceRoot, { recursive: true, force: true })
  evidenceRoot = ''
})

describe('LibreOffice manual evidence verifier', () => {
  it('accepts complete source-bound manual and structural evidence', () => {
    const { manifestPath } = validManifest()
    expect(verify(manifestPath)).toEqual({
      sourceSha,
      testedAt: '2026-08-19T00:00:00.000Z',
      status: 'PASS',
    })
  })

  it('rejects a packet that substitutes structural or visual review claims', () => {
    const { manifest, manifestPath } = validManifest()
    manifest.structuralCorpusPassed = false
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => verify(manifestPath)).toThrow(/structuralCorpusPassed must be true/)

    manifest.structuralCorpusPassed = true
    manifest.libreoffice.impress.assertions.visualLayoutReviewed = false
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => verify(manifestPath)).toThrow(/assertion is incomplete: visualLayoutReviewed/)
  })

  it('rejects source mismatch and credential-like unknown fields', () => {
    const { manifest, manifestPath } = validManifest()
    expect(() => verify(manifestPath, 'fedcba9876543210fedcba9876543210fedcba98')).toThrow(
      /does not match expected release source/,
    )

    const unsafe = manifest as typeof manifest & { profileSecret?: string }
    unsafe.profileSecret = 'must-not-enter-evidence'
    writeFileSync(manifestPath, JSON.stringify(unsafe))
    expect(() => verify(manifestPath)).toThrow(/unknown field: profileSecret/)
  })
})
