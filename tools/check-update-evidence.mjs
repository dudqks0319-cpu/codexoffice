import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultManifest = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../qa-artifacts/release-evidence/update.json',
)
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_OBSERVATION_BYTES = 20 * 1024 * 1024
const MAX_RELEASE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000
const requiredKinds = [
  'previous-release',
  'next-release',
  'app-update-yml',
  'latest-mac-yml',
  'success-evidence',
  'failure-evidence',
]

function fail(message) {
  throw new Error(`[update-evidence] ${message}`)
}

function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} is invalid`)
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} contains unknown field: ${key}`)
  }
}

function hashFile(path, algorithm, encoding) {
  const hash = createHash(algorithm)
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  const fd = openSync(path, 'r')
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest(encoding)
}

function maxBytesForKind(kind) {
  if (kind === 'previous-release' || kind === 'next-release') return MAX_RELEASE_BYTES
  if (kind === 'app-update-yml' || kind === 'latest-mac-yml') return MAX_METADATA_BYTES
  return MAX_OBSERVATION_BYTES
}

function validateArtifact(evidenceRoot, descriptor, label) {
  assertExactKeys(descriptor, ['kind', 'path', 'sha256'], label)
  if (!requiredKinds.includes(descriptor.kind)) fail(`${label} kind is invalid`)
  if (typeof descriptor.path !== 'string' || !descriptor.path || descriptor.path.length > 512) {
    fail(`${label} path is missing`)
  }
  if (!SHA256_PATTERN.test(descriptor.sha256)) fail(`${label} sha256 is invalid`)
  if (isAbsolute(descriptor.path)) fail(`${label} path must be relative`)
  const resolved = resolve(evidenceRoot, descriptor.path)
  const rel = relative(evidenceRoot, resolved)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    fail(`${label} leaves evidence root`)
  }
  const info = lstatSync(resolved, { throwIfNoEntry: false })
  if (!info || info.isSymbolicLink() || !info.isFile()) fail(`${label} is not a regular file`)
  if (info.size <= 0 || info.size > maxBytesForKind(descriptor.kind)) {
    fail(`${label} is empty or oversized`)
  }
  const canonicalRoot = realpathSync(evidenceRoot)
  const canonicalResolved = realpathSync(resolved)
  const canonicalRel = relative(canonicalRoot, canonicalResolved)
  if (canonicalRel === '..' || canonicalRel.startsWith('../') || isAbsolute(canonicalRel)) {
    fail(`${label} resolves outside evidence root`)
  }
  if (hashFile(resolved, 'sha256', 'hex') !== descriptor.sha256) {
    fail(`${label} digest mismatch`)
  }
  return { path: resolved, size: info.size }
}

function readYamlScalar(path, key, label) {
  const text = readFileSync(path, 'utf8')
  const prefix = `${key}:`
  const values = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim())
  if (values.length !== 1 || !values[0]) fail(`${label} must contain one ${key}`)
  const value = values[0]
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed !== 'string') fail(`${label} ${key} is invalid`)
      return parsed
    } catch {
      fail(`${label} ${key} is invalid`)
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (/\s+#/.test(value)) return value.replace(/\s+#.*$/, '').trim()
  return value
}

function parseVersion(value, label) {
  if (typeof value !== 'string' || value.length > 64) {
    fail(`${label} must be a stable semantic version`)
  }
  const match = VERSION_PATTERN.exec(value)
  if (!match) fail(`${label} must be a stable semantic version`)
  const parts = match.slice(1).map(Number)
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    fail(`${label} contains an unsafe numeric component`)
  }
  return parts
}

function isGreaterVersion(next, previous) {
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== previous[index]) return next[index] > previous[index]
  }
  return false
}

function assertFreshTimestamp(value, now, maxAgeMs, label) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || timestamp > now + 5 * 60_000 || now - timestamp > maxAgeMs) {
    fail(`${label} is invalid, in the future, or stale`)
  }
}

function assertSafeUpdateUrl(value, label) {
  if (typeof value !== 'string' || value !== value.trim()) fail(`${label} is invalid`)
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    fail(`${label} is invalid`)
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.toString().replace(/\/+$/, '') !== value
  ) {
    fail(`${label} is invalid`)
  }
}

export function verifyUpdateEvidence(manifestPath = defaultManifest, options = {}) {
  const absoluteManifest = resolve(manifestPath)
  const evidenceRoot = dirname(absoluteManifest)
  const expectedSourceSha = options.expectedSourceSha?.trim().toLowerCase() ?? ''
  const expectedUpdateUrl = options.expectedUpdateUrl?.trim() ?? ''
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  if (!SOURCE_SHA_PATTERN.test(expectedSourceSha)) fail('expected source SHA is missing or invalid')
  assertSafeUpdateUrl(expectedUpdateUrl, 'expected update URL')
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
    if (error instanceof Error && error.message.startsWith('[update-evidence]')) throw error
    fail(error?.code === 'ENOENT' ? 'manifest is missing' : 'manifest is invalid JSON')
  }

  if (manifest.schemaVersion !== 1) fail('schemaVersion must be 1')
  assertExactKeys(
    manifest,
    [
      'schemaVersion',
      'sourceSha',
      'verifiedAt',
      'updateUrl',
      'platform',
      'architecture',
      'fromVersion',
      'toVersion',
      'artifacts',
      'success',
      'failure',
    ],
    'manifest',
  )
  if (!SOURCE_SHA_PATTERN.test(manifest.sourceSha)) fail('sourceSha is invalid')
  if (manifest.sourceSha !== expectedSourceSha) {
    fail('sourceSha does not match expected release source')
  }
  assertFreshTimestamp(manifest.verifiedAt, now, maxAgeMs, 'verifiedAt')
  assertSafeUpdateUrl(manifest.updateUrl, 'updateUrl')
  if (manifest.updateUrl !== expectedUpdateUrl) fail('updateUrl does not match release channel')
  if (manifest.platform !== 'darwin') fail('platform must be darwin')
  if (!['arm64', 'x64', 'universal'].includes(manifest.architecture)) {
    fail('architecture is invalid')
  }
  const previousVersion = parseVersion(manifest.fromVersion, 'fromVersion')
  const nextVersion = parseVersion(manifest.toVersion, 'toVersion')
  if (!isGreaterVersion(nextVersion, previousVersion))
    fail('toVersion must be newer than fromVersion')

  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== requiredKinds.length) {
    fail('artifacts must contain exactly six required files')
  }
  const artifacts = new Map()
  const paths = new Set()
  let totalBytes = 0
  manifest.artifacts.forEach((artifact, index) => {
    if (artifacts.has(artifact?.kind)) fail('artifact kinds must be distinct')
    if (paths.has(artifact?.path)) fail('artifact paths must be distinct')
    const validated = validateArtifact(evidenceRoot, artifact, `artifact ${index + 1}`)
    artifacts.set(artifact.kind, { ...artifact, ...validated })
    paths.add(artifact.path)
    totalBytes += validated.size
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
      fail('total artifact bytes exceed the release evidence budget')
    }
  })
  for (const kind of requiredKinds) {
    if (!artifacts.has(kind)) fail(`required artifact is missing: ${kind}`)
  }
  if (artifacts.get('previous-release').sha256 === artifacts.get('next-release').sha256) {
    fail('previous and next release artifacts must differ')
  }

  const appUpdatePath = artifacts.get('app-update-yml').path
  if (readYamlScalar(appUpdatePath, 'provider', 'app-update.yml') !== 'generic') {
    fail('app-update.yml provider must be generic')
  }
  if (readYamlScalar(appUpdatePath, 'url', 'app-update.yml') !== expectedUpdateUrl) {
    fail('app-update.yml URL does not match release channel')
  }

  const latestMacPath = artifacts.get('latest-mac-yml').path
  if (readYamlScalar(latestMacPath, 'version', 'latest-mac.yml') !== manifest.toVersion) {
    fail('latest-mac.yml version does not match toVersion')
  }
  const publishedPath = readYamlScalar(latestMacPath, 'path', 'latest-mac.yml')
  if (
    basename(publishedPath) !== publishedPath ||
    publishedPath !== basename(artifacts.get('next-release').path)
  ) {
    fail('latest-mac.yml path does not match next release artifact')
  }
  const publishedSha512 = readYamlScalar(latestMacPath, 'sha512', 'latest-mac.yml')
  if (publishedSha512 !== hashFile(artifacts.get('next-release').path, 'sha512', 'base64')) {
    fail('latest-mac.yml sha512 does not match next release artifact')
  }

  assertExactKeys(
    manifest.success,
    [
      'status',
      'observedAt',
      'startedVersion',
      'offeredVersion',
      'downloadCompleted',
      'signatureVerified',
      'installCompleted',
      'relaunchVersion',
      'userDataPreserved',
    ],
    'success',
  )
  assertFreshTimestamp(manifest.success?.observedAt, now, maxAgeMs, 'success observedAt')
  if (
    manifest.success?.status !== 'PASS' ||
    manifest.success.startedVersion !== manifest.fromVersion ||
    manifest.success.offeredVersion !== manifest.toVersion ||
    manifest.success.downloadCompleted !== true ||
    manifest.success.signatureVerified !== true ||
    manifest.success.installCompleted !== true ||
    manifest.success.relaunchVersion !== manifest.toVersion ||
    manifest.success.userDataPreserved !== true
  ) {
    fail('successful N-to-N+1 exercise is incomplete')
  }

  assertExactKeys(
    manifest.failure,
    [
      'status',
      'observedAt',
      'mode',
      'startedVersion',
      'attemptedVersion',
      'installAttempted',
      'quitAndInstallCalled',
      'runningVersionAfterFailure',
      'previousArtifactPreserved',
      'userDataPreserved',
      'retrySucceeded',
    ],
    'failure',
  )
  assertFreshTimestamp(manifest.failure?.observedAt, now, maxAgeMs, 'failure observedAt')
  if (
    manifest.failure?.status !== 'PASS' ||
    !['download', 'signature'].includes(manifest.failure.mode) ||
    manifest.failure.startedVersion !== manifest.fromVersion ||
    manifest.failure.attemptedVersion !== manifest.toVersion ||
    manifest.failure.installAttempted !== false ||
    manifest.failure.quitAndInstallCalled !== false ||
    manifest.failure.runningVersionAfterFailure !== manifest.fromVersion ||
    manifest.failure.previousArtifactPreserved !== true ||
    manifest.failure.userDataPreserved !== true ||
    manifest.failure.retrySucceeded !== true
  ) {
    fail('failed-update preservation exercise is incomplete')
  }

  return {
    sourceSha: manifest.sourceSha,
    verifiedAt: manifest.verifiedAt,
    fromVersion: manifest.fromVersion,
    toVersion: manifest.toVersion,
    status: 'PASS',
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyUpdateEvidence(process.argv[2] ?? defaultManifest, {
      expectedSourceSha: process.env.GENOFFICE_SOURCE_SHA,
      expectedUpdateUrl: process.env.GENOFFICE_UPDATE_URL,
    })
    console.log(
      `[update-evidence] PASS source ${result.sourceSha} ${result.fromVersion} -> ${result.toVersion} verified ${result.verifiedAt}`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : '[update-evidence] verification failed')
    process.exitCode = 1
  }
}
