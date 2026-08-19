import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_RELEASE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_DOCUMENT_BYTES = 512 * 1024 * 1024
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000

function fail(prefix, message) {
  throw new Error(`[${prefix}] ${message}`)
}

function assertExactKeys(value, allowed, label, prefix) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(prefix, `${label} is invalid`)
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(prefix, `${label} contains unknown field: ${key}`)
  }
}

function assertBoundedText(value, label, prefix) {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > 200 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  ) {
    fail(prefix, `${label} is missing or invalid`)
  }
}

function assertFreshTimestamp(value, now, maxAgeMs, label, prefix) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(timestamp) || timestamp > now + 5 * 60_000 || now - timestamp > maxAgeMs) {
    fail(prefix, `${label} is invalid, in the future, or stale`)
  }
}

function hashFile(path) {
  const hash = createHash('sha256')
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
  return hash.digest('hex')
}

function readBytes(path, offset, length) {
  const buffer = Buffer.alloc(length)
  const fd = openSync(path, 'r')
  try {
    const bytesRead = readSync(fd, buffer, 0, length, offset)
    return buffer.subarray(0, bytesRead)
  } finally {
    closeSync(fd)
  }
}

function hasZipSignature(bytes) {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  )
}

function assertFileKind(path, size, kind, expectedExtension, label, prefix) {
  const extension = extname(path).toLowerCase()
  if (kind === 'release') {
    if (extension === '.zip') {
      if (!hasZipSignature(readBytes(path, 0, 4))) fail(prefix, `${label} is not a ZIP file`)
      return
    }
    if (extension === '.dmg') {
      if (size < 512 || readBytes(path, size - 512, 4).toString('ascii') !== 'koly') {
        fail(prefix, `${label} is not a DMG file`)
      }
      return
    }
    fail(prefix, `${label} must be a DMG or ZIP file`)
  }
  if (kind === 'document') {
    if (extension !== expectedExtension || !hasZipSignature(readBytes(path, 0, 4))) {
      fail(prefix, `${label} is not an ${expectedExtension} OOXML file`)
    }
    return
  }
  if (kind === 'screenshot') {
    const bytes = readBytes(path, 0, 8)
    const isPng =
      extension === '.png' &&
      bytes.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const isJpeg =
      ['.jpg', '.jpeg'].includes(extension) &&
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    if (!isPng && !isJpeg) fail(prefix, `${label} is not a PNG or JPEG image`)
  }
}

function validateFile(
  evidenceRoot,
  canonicalRoot,
  descriptor,
  label,
  maxBytes,
  seenFiles,
  prefix,
  kind,
  expectedExtension,
) {
  assertExactKeys(descriptor, ['path', 'sha256'], label, prefix)
  if (typeof descriptor.path !== 'string' || !descriptor.path || descriptor.path.length > 512) {
    fail(prefix, `${label} path is missing`)
  }
  if (!SHA256_PATTERN.test(descriptor.sha256)) fail(prefix, `${label} sha256 is invalid`)
  if (isAbsolute(descriptor.path)) fail(prefix, `${label} path must be relative`)
  const resolved = resolve(evidenceRoot, descriptor.path)
  const rel = relative(evidenceRoot, resolved)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    fail(prefix, `${label} leaves evidence root`)
  }
  const info = lstatSync(resolved, { throwIfNoEntry: false })
  if (!info || info.isSymbolicLink() || !info.isFile()) {
    fail(prefix, `${label} is not a regular file`)
  }
  if (info.size <= 0 || info.size > maxBytes) fail(prefix, `${label} is empty or oversized`)
  const canonicalResolved = realpathSync(resolved)
  const canonicalRel = relative(canonicalRoot, canonicalResolved)
  if (canonicalRel === '..' || canonicalRel.startsWith('../') || isAbsolute(canonicalRel)) {
    fail(prefix, `${label} resolves outside evidence root`)
  }
  if (seenFiles.has(canonicalResolved)) fail(prefix, `${label} path is duplicated`)
  assertFileKind(resolved, info.size, kind, expectedExtension, label, prefix)
  if (hashFile(resolved) !== descriptor.sha256) fail(prefix, `${label} digest mismatch`)
  seenFiles.add(canonicalResolved)
  return info.size
}

export function verifyManualOfficeEvidence(manifestPath, options) {
  const absoluteManifest = resolve(manifestPath)
  const evidenceRoot = dirname(absoluteManifest)
  const expectedSourceSha = options.expectedSourceSha?.trim().toLowerCase() ?? ''
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const prefix = options.errorPrefix
  if (!SOURCE_SHA_PATTERN.test(expectedSourceSha)) {
    fail(prefix, 'expected source SHA is missing or invalid')
  }
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    fail(prefix, 'verification clock is invalid')
  }
  const evidenceRootInfo = lstatSync(evidenceRoot, { throwIfNoEntry: false })
  if (!evidenceRootInfo || evidenceRootInfo.isSymbolicLink() || !evidenceRootInfo.isDirectory()) {
    fail(prefix, 'evidence root is missing')
  }
  const canonicalRoot = realpathSync(evidenceRoot)

  let manifest
  try {
    const manifestInfo = lstatSync(absoluteManifest, { throwIfNoEntry: false })
    if (
      !manifestInfo ||
      manifestInfo.isSymbolicLink() ||
      !manifestInfo.isFile() ||
      manifestInfo.size <= 0 ||
      manifestInfo.size > MAX_MANIFEST_BYTES
    ) {
      fail(prefix, 'manifest is missing, unsafe, empty, or oversized')
    }
    manifest = JSON.parse(readFileSync(absoluteManifest, 'utf8'))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`[${prefix}]`)) throw error
    fail(prefix, error?.code === 'ENOENT' ? 'manifest is missing' : 'manifest is invalid JSON')
  }

  assertExactKeys(
    manifest,
    [
      'schemaVersion',
      'sourceSha',
      'testedAt',
      'macosVersion',
      'architecture',
      'releaseArtifact',
      options.suiteKey,
      ...(options.extraManifestKeys ?? []),
    ],
    'manifest',
    prefix,
  )
  if (manifest.schemaVersion !== 2) fail(prefix, 'schemaVersion must be 2')
  if (!SOURCE_SHA_PATTERN.test(manifest.sourceSha)) fail(prefix, 'sourceSha is invalid')
  if (manifest.sourceSha !== expectedSourceSha) {
    fail(prefix, 'sourceSha does not match expected release source')
  }
  assertFreshTimestamp(manifest.testedAt, now, maxAgeMs, 'testedAt', prefix)
  assertBoundedText(manifest.macosVersion, 'macosVersion', prefix)
  if (!['arm64', 'x64'].includes(manifest.architecture)) {
    fail(prefix, 'architecture is invalid')
  }
  options.validateManifestExtras?.(manifest, (message) => fail(prefix, message))

  const seenFiles = new Set()
  let totalBytes = validateFile(
    evidenceRoot,
    canonicalRoot,
    manifest.releaseArtifact,
    'release artifact',
    MAX_RELEASE_BYTES,
    seenFiles,
    prefix,
    'release',
  )

  const suite = manifest[options.suiteKey]
  const appNames = Object.keys(options.requiredAssertions)
  assertExactKeys(suite, appNames, options.suiteKey, prefix)
  for (const appName of appNames) {
    const result = suite[appName]
    assertExactKeys(
      result,
      ['status', 'version', 'fixture', 'savedDocument', 'screenshots', 'assertions'],
      appName,
      prefix,
    )
    if (result.status !== 'PASS') fail(prefix, `${appName} status must be PASS`)
    assertBoundedText(result.version, `${appName} version`, prefix)
    totalBytes += validateFile(
      evidenceRoot,
      canonicalRoot,
      result.fixture,
      `${appName} fixture`,
      MAX_DOCUMENT_BYTES,
      seenFiles,
      prefix,
      'document',
      options.documentExtensions[appName],
    )
    totalBytes += validateFile(
      evidenceRoot,
      canonicalRoot,
      result.savedDocument,
      `${appName} saved document`,
      MAX_DOCUMENT_BYTES,
      seenFiles,
      prefix,
      'document',
      options.documentExtensions[appName],
    )
    if (result.fixture.sha256 === result.savedDocument.sha256) {
      fail(prefix, `${appName} fixture and saved document must differ`)
    }
    if (
      !Array.isArray(result.screenshots) ||
      result.screenshots.length < 3 ||
      result.screenshots.length > 12
    ) {
      fail(prefix, `${appName} requires between three and twelve screenshots`)
    }
    result.screenshots.forEach((entry, index) => {
      totalBytes += validateFile(
        evidenceRoot,
        canonicalRoot,
        entry,
        `${appName} screenshot ${index + 1}`,
        MAX_SCREENSHOT_BYTES,
        seenFiles,
        prefix,
        'screenshot',
      )
    })
    const assertions = options.requiredAssertions[appName]
    assertExactKeys(result.assertions, assertions, `${appName} assertions`, prefix)
    for (const assertion of assertions) {
      if (result.assertions[assertion] !== true) {
        fail(prefix, `${appName} assertion is incomplete: ${assertion}`)
      }
    }
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
      fail(prefix, 'total evidence bytes exceed the release evidence budget')
    }
  }

  return { sourceSha: manifest.sourceSha, testedAt: manifest.testedAt, status: 'PASS' }
}
