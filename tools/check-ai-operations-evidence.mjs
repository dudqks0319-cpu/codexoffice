import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultManifest = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../qa-artifacts/release-evidence/ai-operations.json',
)
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_ARTIFACT_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000
const requiredArtifactKinds = [
  'provider-hard-cap',
  'usage-alert',
  'kill-switch',
  'cost-attribution-log',
]

function fail(message) {
  throw new Error(`[ai-operations-evidence] ${message}`)
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} is invalid`)
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} contains unknown field: ${key}`)
  }
}

function validateFile(evidenceRoot, descriptor, label) {
  assertExactKeys(descriptor, ['kind', 'path', 'sha256'], label)
  if (
    !descriptor ||
    typeof descriptor.path !== 'string' ||
    !descriptor.path ||
    descriptor.path.length > 512
  ) {
    fail(`${label} path is missing`)
  }
  if (!SHA256_PATTERN.test(descriptor.sha256)) fail(`${label} sha256 is invalid`)
  if (isAbsolute(descriptor.path)) fail(`${label} path must be relative`)
  const resolved = resolve(evidenceRoot, descriptor.path)
  const rel = relative(evidenceRoot, resolved)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
    fail(`${label} leaves evidence root`)
  const info = lstatSync(resolved, { throwIfNoEntry: false })
  if (!info || info.isSymbolicLink() || !info.isFile()) fail(`${label} is not a regular file`)
  if (info.size <= 0 || info.size > MAX_ARTIFACT_BYTES) {
    fail(`${label} is empty or oversized`)
  }
  const canonicalRoot = realpathSync(evidenceRoot)
  const canonicalResolved = realpathSync(resolved)
  const canonicalRel = relative(canonicalRoot, canonicalResolved)
  if (canonicalRel === '..' || canonicalRel.startsWith('../') || isAbsolute(canonicalRel)) {
    fail(`${label} resolves outside evidence root`)
  }
  if (sha256(resolved) !== descriptor.sha256) fail(`${label} digest mismatch`)
  return info.size
}

export function verifyAiOperationsEvidence(manifestPath = defaultManifest, options = {}) {
  const absoluteManifest = resolve(manifestPath)
  const evidenceRoot = dirname(absoluteManifest)
  const expectedSourceSha = options.expectedSourceSha?.trim().toLowerCase() ?? ''
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  if (!SOURCE_SHA_PATTERN.test(expectedSourceSha)) fail('expected source SHA is missing or invalid')
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    fail('verification clock is invalid')
  }
  const rootInfo = lstatSync(evidenceRoot, { throwIfNoEntry: false })
  if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    fail('evidence root is missing')
  }

  let manifest
  try {
    const info = lstatSync(absoluteManifest, { throwIfNoEntry: false })
    if (!info || info.isSymbolicLink() || !info.isFile() || info.size > MAX_MANIFEST_BYTES) {
      fail('manifest is missing, unsafe, or oversized')
    }
    manifest = JSON.parse(readFileSync(absoluteManifest, 'utf8'))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('[ai-operations-evidence]')) throw error
    fail(error?.code === 'ENOENT' ? 'manifest is missing' : 'manifest is invalid JSON')
  }

  if (manifest.schemaVersion !== 1) fail('schemaVersion must be 1')
  assertExactKeys(
    manifest,
    [
      'schemaVersion',
      'sourceSha',
      'verifiedAt',
      'provider',
      'accountFingerprint',
      'hardCap',
      'alert',
      'killSwitch',
      'distributedAccounting',
      'artifacts',
    ],
    'manifest',
  )
  if (!SOURCE_SHA_PATTERN.test(manifest.sourceSha)) fail('sourceSha is invalid')
  if (manifest.sourceSha !== expectedSourceSha)
    fail('sourceSha does not match expected release source')
  const verifiedAt = Date.parse(manifest.verifiedAt)
  if (
    !Number.isFinite(verifiedAt) ||
    verifiedAt > now + 5 * 60_000 ||
    now - verifiedAt > maxAgeMs
  ) {
    fail('verifiedAt is invalid, in the future, or stale')
  }
  if (
    typeof manifest.provider !== 'string' ||
    !manifest.provider.trim() ||
    manifest.provider.length > 100
  ) {
    fail('provider is missing')
  }
  if (!SHA256_PATTERN.test(manifest.accountFingerprint)) {
    fail('accountFingerprint must be a non-sensitive SHA-256 value')
  }
  assertExactKeys(
    manifest.hardCap,
    ['providerEnforced', 'currency', 'period', 'amountCents'],
    'hardCap',
  )
  if (
    manifest.hardCap?.providerEnforced !== true ||
    manifest.hardCap?.currency !== 'USD' ||
    !['daily', 'monthly'].includes(manifest.hardCap?.period) ||
    !Number.isSafeInteger(manifest.hardCap?.amountCents) ||
    manifest.hardCap.amountCents <= 0 ||
    manifest.hardCap.amountCents > 1_000_000_000
  ) {
    fail('provider hard cap is incomplete')
  }
  assertExactKeys(manifest.alert, ['enabled', 'thresholdPercent'], 'alert')
  if (
    manifest.alert?.enabled !== true ||
    !Number.isSafeInteger(manifest.alert?.thresholdPercent) ||
    manifest.alert.thresholdPercent <= 0 ||
    manifest.alert.thresholdPercent > 80
  ) {
    fail('usage alert must be enabled at or below 80 percent')
  }
  assertExactKeys(
    manifest.killSwitch,
    ['providerVerified', 'applicationVerified', 'exercisedAt'],
    'killSwitch',
  )
  if (
    manifest.killSwitch?.providerVerified !== true ||
    manifest.killSwitch?.applicationVerified !== true
  ) {
    fail('kill switch evidence is incomplete')
  }
  const killSwitchExercisedAt = Date.parse(manifest.killSwitch.exercisedAt)
  if (
    !Number.isFinite(killSwitchExercisedAt) ||
    killSwitchExercisedAt > now + 5 * 60_000 ||
    now - killSwitchExercisedAt > maxAgeMs
  ) {
    fail('kill switch exercise is invalid, in the future, or stale')
  }
  assertExactKeys(
    manifest.distributedAccounting,
    ['providerAccountAggregate', 'multiClientVerified'],
    'distributedAccounting',
  )
  if (
    manifest.distributedAccounting?.providerAccountAggregate !== true ||
    manifest.distributedAccounting?.multiClientVerified !== true
  ) {
    fail('distributed accounting evidence is incomplete')
  }
  if (
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length < requiredArtifactKinds.length ||
    manifest.artifacts.length > 12
  ) {
    fail('artifacts must contain between four and twelve files')
  }
  const kinds = new Set()
  const paths = new Set()
  let totalArtifactBytes = 0
  manifest.artifacts.forEach((artifact, index) => {
    if (!requiredArtifactKinds.includes(artifact?.kind))
      fail(`artifact ${index + 1} kind is invalid`)
    if (paths.has(artifact.path)) fail('artifact paths must be distinct')
    paths.add(artifact.path)
    kinds.add(artifact.kind)
    totalArtifactBytes += validateFile(evidenceRoot, artifact, `artifact ${index + 1}`)
    if (totalArtifactBytes > MAX_TOTAL_ARTIFACT_BYTES) {
      fail('total artifact bytes exceed the release evidence budget')
    }
  })
  for (const kind of requiredArtifactKinds) {
    if (!kinds.has(kind)) fail(`required artifact is missing: ${kind}`)
  }

  return { sourceSha: manifest.sourceSha, verifiedAt: manifest.verifiedAt, status: 'PASS' }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyAiOperationsEvidence(process.argv[2] ?? defaultManifest, {
      expectedSourceSha: process.env.GENOFFICE_SOURCE_SHA,
    })
    console.log(
      `[ai-operations-evidence] PASS source ${result.sourceSha} verified ${result.verifiedAt}`,
    )
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : '[ai-operations-evidence] verification failed',
    )
    process.exitCode = 1
  }
}
