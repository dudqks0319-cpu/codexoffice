import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { verifyUpdateEvidence } from '../../../tools/check-update-evidence.mjs'

const sourceSha = '0123456789abcdef0123456789abcdef01234567'
const updateUrl = 'https://updates.example.com/codexoffice'
const verifiedAt = '2026-08-19T00:00:00.000Z'
const now = Date.parse('2026-08-19T01:00:00.000Z')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function digest(path: string, algorithm: 'sha256' | 'sha512', encoding: 'hex' | 'base64') {
  return createHash(algorithm).update(readFileSync(path)).digest(encoding)
}

function makePacket() {
  const root = mkdtempSync(join(tmpdir(), 'genoffice-update-evidence-'))
  roots.push(root)
  const previousReleaseName = 'Codexoffice-0.1.0-arm64-mac.zip'
  const nextReleaseName = 'Codexoffice-0.2.0-arm64-mac.zip'
  writeFileSync(join(root, previousReleaseName), 'previous signed release bytes')
  writeFileSync(join(root, nextReleaseName), 'next signed release bytes')
  writeFileSync(
    join(root, 'app-update.yml'),
    `provider: generic\nurl: ${updateUrl}\nupdaterCacheDirName: codexoffice-updater\n`,
  )
  writeFileSync(
    join(root, 'latest-mac.yml'),
    [
      'version: 0.2.0',
      `path: ${nextReleaseName}`,
      `sha512: ${digest(join(root, nextReleaseName), 'sha512', 'base64')}`,
      'releaseDate: 2026-08-19T00:00:00.000Z',
      '',
    ].join('\n'),
  )
  writeFileSync(join(root, 'success-observation.json'), '{"redacted":true,"result":"PASS"}\n')
  writeFileSync(join(root, 'failure-observation.json'), '{"redacted":true,"result":"PASS"}\n')

  const artifactEntries = [
    ['previous-release', previousReleaseName],
    ['next-release', nextReleaseName],
    ['app-update-yml', 'app-update.yml'],
    ['latest-mac-yml', 'latest-mac.yml'],
    ['success-evidence', 'success-observation.json'],
    ['failure-evidence', 'failure-observation.json'],
  ] as const
  const manifest = {
    schemaVersion: 1,
    sourceSha,
    verifiedAt,
    updateUrl,
    platform: 'darwin',
    architecture: 'arm64',
    fromVersion: '0.1.0',
    toVersion: '0.2.0',
    artifacts: artifactEntries.map(([kind, path]) => ({
      kind,
      path,
      sha256: digest(join(root, path), 'sha256', 'hex'),
    })),
    success: {
      status: 'PASS',
      observedAt: verifiedAt,
      startedVersion: '0.1.0',
      offeredVersion: '0.2.0',
      downloadCompleted: true,
      signatureVerified: true,
      installCompleted: true,
      relaunchVersion: '0.2.0',
      userDataPreserved: true,
    },
    failure: {
      status: 'PASS',
      observedAt: verifiedAt,
      mode: 'signature',
      startedVersion: '0.1.0',
      attemptedVersion: '0.2.0',
      installAttempted: false,
      quitAndInstallCalled: false,
      runningVersionAfterFailure: '0.1.0',
      previousArtifactPreserved: true,
      userDataPreserved: true,
      retrySucceeded: true,
    },
  }
  const manifestPath = join(root, 'update.json')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  return { root, manifest, manifestPath, nextReleaseName }
}

function verify(manifestPath: string, overrides = {}) {
  return verifyUpdateEvidence(manifestPath, {
    expectedSourceSha: sourceSha,
    expectedUpdateUrl: updateUrl,
    now,
    ...overrides,
  })
}

describe('update release evidence', () => {
  it('accepts a fresh source/channel/artifact-bound success and failure packet', () => {
    const { manifestPath } = makePacket()

    expect(verify(manifestPath)).toEqual({
      sourceSha,
      verifiedAt,
      fromVersion: '0.1.0',
      toVersion: '0.2.0',
      status: 'PASS',
    })
  })

  it('rejects a packet for another release source or update channel', () => {
    const { manifestPath } = makePacket()

    expect(() =>
      verify(manifestPath, {
        expectedSourceSha: 'fedcba9876543210fedcba9876543210fedcba98',
      }),
    ).toThrow(/sourceSha does not match/)
    expect(() =>
      verify(manifestPath, { expectedUpdateUrl: 'https://other.example.com/codexoffice' }),
    ).toThrow(/updateUrl does not match/)
  })

  it('rejects tampered release bytes and mismatched latest-mac metadata', () => {
    const { root, manifest, manifestPath, nextReleaseName } = makePacket()
    writeFileSync(join(root, nextReleaseName), 'tampered release bytes')

    expect(() => verify(manifestPath)).toThrow(/digest mismatch/)

    writeFileSync(join(root, nextReleaseName), 'next signed release bytes')
    const nextArtifact = manifest.artifacts.find(({ kind }) => kind === 'next-release')!
    nextArtifact.sha256 = digest(join(root, nextReleaseName), 'sha256', 'hex')
    writeFileSync(join(root, 'latest-mac.yml'), 'version: 0.2.0\npath: wrong.zip\nsha512: wrong\n')
    const metadata = manifest.artifacts.find(({ kind }) => kind === 'latest-mac-yml')!
    metadata.sha256 = digest(join(root, 'latest-mac.yml'), 'sha256', 'hex')
    writeFileSync(manifestPath, JSON.stringify(manifest))

    expect(() => verify(manifestPath)).toThrow(/path does not match/)
  })

  it('rejects incomplete failure preservation and non-increasing versions', () => {
    const { manifest, manifestPath } = makePacket()
    manifest.failure.userDataPreserved = false
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => verify(manifestPath)).toThrow(/failed-update preservation exercise is incomplete/)

    manifest.failure.userDataPreserved = true
    manifest.toVersion = '0.1.0'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => verify(manifestPath)).toThrow(/toVersion must be newer/)
  })

  it('rejects non-string and unsafe numeric version components', () => {
    const { manifest, manifestPath } = makePacket()
    const invalid = manifest as Omit<typeof manifest, 'toVersion'> & { toVersion: string | number }
    invalid.toVersion = 2
    writeFileSync(manifestPath, JSON.stringify(invalid))
    expect(() => verify(manifestPath)).toThrow(/toVersion must be a stable semantic version/)

    invalid.toVersion = '9007199254740992.0.0'
    writeFileSync(manifestPath, JSON.stringify(invalid))
    expect(() => verify(manifestPath)).toThrow(/unsafe numeric component/)
  })

  it('rejects stale observations independently of artifact integrity', () => {
    const { manifest, manifestPath } = makePacket()
    manifest.failure.observedAt = '2026-06-01T00:00:00.000Z'
    writeFileSync(manifestPath, JSON.stringify(manifest))

    expect(() => verify(manifestPath)).toThrow(/failure observedAt is invalid/)
  })

  it('rejects path traversal and symlinked evidence', () => {
    const { root, manifest, manifestPath } = makePacket()
    manifest.artifacts[4]!.path = '../outside.json'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => verify(manifestPath)).toThrow(/leaves evidence root/)

    const { root: secondRoot, manifest: secondManifest, manifestPath: secondPath } = makePacket()
    const observation = secondManifest.artifacts[4]!
    const original = join(secondRoot, observation.path)
    const target = join(secondRoot, 'success-target.json')
    writeFileSync(target, readFileSync(original))
    rmSync(original)
    symlinkSync(target, original)
    writeFileSync(secondPath, JSON.stringify(secondManifest))
    expect(() => verify(secondPath)).toThrow(/not a regular file/)

    expect(root).not.toBe(secondRoot)
  })

  it('rejects unknown fields that could hide credentials', () => {
    const { manifest, manifestPath } = makePacket()
    const unsafe = manifest as typeof manifest & { channelToken?: string }
    unsafe.channelToken = 'must-not-enter-release-evidence'
    writeFileSync(manifestPath, JSON.stringify(unsafe))

    expect(() => verify(manifestPath)).toThrow(/unknown field: channelToken/)
  })
})
