import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { verifyAiOperationsEvidence } from '../../../tools/check-ai-operations-evidence.mjs'

const sourceSha = '0123456789abcdef0123456789abcdef01234567'
const verifiedAt = '2026-08-19T00:00:00.000Z'
const now = Date.parse('2026-08-19T01:00:00.000Z')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function makePacket() {
  const root = mkdtempSync(join(tmpdir(), 'genoffice-ai-operations-evidence-'))
  roots.push(root)
  const artifacts = [
    ['provider-hard-cap', 'provider-hard-cap-redacted.png'],
    ['usage-alert', 'usage-alert-redacted.png'],
    ['kill-switch', 'kill-switch-test-redacted.json'],
    ['cost-attribution-log', 'cost-attribution-redacted.json'],
  ] as const
  for (const [kind, name] of artifacts) writeFileSync(join(root, name), `${kind}\n`)
  const manifest = {
    schemaVersion: 1,
    sourceSha,
    verifiedAt,
    provider: 'openai-codex',
    accountFingerprint: 'a'.repeat(64),
    hardCap: {
      providerEnforced: true,
      currency: 'USD',
      period: 'monthly',
      amountCents: 10_000,
    },
    alert: { enabled: true, thresholdPercent: 80 },
    killSwitch: {
      providerVerified: true,
      applicationVerified: true,
      exercisedAt: verifiedAt,
    },
    distributedAccounting: {
      providerAccountAggregate: true,
      multiClientVerified: true,
    },
    artifacts: artifacts.map(([kind, path]) => ({
      kind,
      path,
      sha256: sha256(join(root, path)),
    })),
  }
  const manifestPath = join(root, 'ai-operations.json')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  return { root, manifest, manifestPath }
}

describe('AI operations release evidence', () => {
  it('accepts a fresh source-bound packet with all external controls', () => {
    const { manifestPath } = makePacket()

    expect(verifyAiOperationsEvidence(manifestPath, { expectedSourceSha: sourceSha, now })).toEqual(
      { sourceSha, verifiedAt, status: 'PASS' },
    )
  })

  it('rejects artifact digest drift', () => {
    const { root, manifestPath } = makePacket()
    writeFileSync(join(root, 'usage-alert-redacted.png'), 'changed bytes\n')

    expect(() =>
      verifyAiOperationsEvidence(manifestPath, { expectedSourceSha: sourceSha, now }),
    ).toThrow(/digest mismatch/)
  })

  it('rejects path traversal before reading outside the evidence directory', () => {
    const { manifest, manifestPath } = makePacket()
    manifest.artifacts[0]!.path = '../outside.png'
    writeFileSync(manifestPath, JSON.stringify(manifest))

    expect(() =>
      verifyAiOperationsEvidence(manifestPath, { expectedSourceSha: sourceSha, now }),
    ).toThrow(/leaves evidence root/)
  })

  it('rejects stale or incomplete provider controls', () => {
    const { manifest, manifestPath } = makePacket()
    manifest.verifiedAt = '2026-06-01T00:00:00.000Z'
    manifest.distributedAccounting.multiClientVerified = false
    writeFileSync(manifestPath, JSON.stringify(manifest))

    expect(() =>
      verifyAiOperationsEvidence(manifestPath, { expectedSourceSha: sourceSha, now }),
    ).toThrow(/verifiedAt is invalid, in the future, or stale/)
  })

  it('rejects stale kill-switch exercises independently of the packet timestamp', () => {
    const { manifest, manifestPath } = makePacket()
    manifest.killSwitch.exercisedAt = '2026-06-01T00:00:00.000Z'
    writeFileSync(manifestPath, JSON.stringify(manifest))

    expect(() =>
      verifyAiOperationsEvidence(manifestPath, { expectedSourceSha: sourceSha, now }),
    ).toThrow(/kill switch exercise is invalid, in the future, or stale/)
  })

  it('rejects oversized evidence artifacts before hashing their contents', () => {
    const { root, manifest, manifestPath } = makePacket()
    const artifact = manifest.artifacts.find(({ kind }) => kind === 'cost-attribution-log')!
    writeFileSync(join(root, artifact.path), Buffer.alloc(20 * 1024 * 1024 + 1))
    artifact.sha256 = sha256(join(root, artifact.path))
    writeFileSync(manifestPath, JSON.stringify(manifest))

    expect(() =>
      verifyAiOperationsEvidence(manifestPath, { expectedSourceSha: sourceSha, now }),
    ).toThrow(/artifact 4 is empty or oversized/)
  })

  it('requires a redacted cost-attribution log artifact', () => {
    const { manifest, manifestPath } = makePacket()
    manifest.artifacts = manifest.artifacts.filter(({ kind }) => kind !== 'cost-attribution-log')
    writeFileSync(manifestPath, JSON.stringify(manifest))

    expect(() =>
      verifyAiOperationsEvidence(manifestPath, { expectedSourceSha: sourceSha, now }),
    ).toThrow(/artifacts must contain between four and twelve files/)
  })

  it('rejects unknown manifest fields that could hide credentials', () => {
    const { manifest, manifestPath } = makePacket()
    const unsafe = manifest as typeof manifest & { apiKey?: string }
    unsafe.apiKey = 'must-never-enter-release-evidence'
    writeFileSync(manifestPath, JSON.stringify(unsafe))

    expect(() =>
      verifyAiOperationsEvidence(manifestPath, { expectedSourceSha: sourceSha, now }),
    ).toThrow(/manifest contains unknown field: apiKey/)
  })
})
