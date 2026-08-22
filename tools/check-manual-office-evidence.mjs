import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_RELEASE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_DOCUMENT_BYTES = 512 * 1024 * 1024
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024
const MAX_ZIP_DIRECTORY_BYTES = 8 * 1024 * 1024
const MAX_ZIP_ENTRIES = 10_000
const MAX_RELEASE_IDENTITY_BYTES = 64 * 1024
const MAX_PACKAGE_PAYLOAD_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000
const RELEASE_IDENTITY_SUFFIX = '/Contents/Resources/release-identity.json'
const RELEASE_PAYLOAD_PATH = 'Contents/Resources/app.asar'
const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_CENTRAL_HEADER_SIGNATURE = 0x02014b50
const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50

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

function hashFileDescriptor(fd, expectedBytes) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let offset = 0
  for (;;) {
    if (expectedBytes !== undefined && offset === expectedBytes) break
    const requested =
      expectedBytes === undefined ? buffer.length : Math.min(buffer.length, expectedBytes - offset)
    const bytesRead = readSync(fd, buffer, 0, requested, offset)
    if (bytesRead === 0) break
    hash.update(buffer.subarray(0, bytesRead))
    offset += bytesRead
  }
  if (expectedBytes !== undefined && offset !== expectedBytes) {
    throw new Error('file length changed while hashing')
  }
  return hash.digest('hex')
}

function hashFile(path) {
  const fd = openSync(path, 'r')
  try {
    return hashFileDescriptor(fd)
  } finally {
    closeSync(fd)
  }
}

function readBytesFromDescriptor(fd, offset, length) {
  const buffer = Buffer.alloc(length)
  let total = 0
  while (total < length) {
    const bytesRead = readSync(fd, buffer, total, length - total, offset + total)
    if (bytesRead === 0) break
    total += bytesRead
  }
  return buffer.subarray(0, total)
}

function readBytes(path, offset, length) {
  const fd = openSync(path, 'r')
  try {
    return readBytesFromDescriptor(fd, offset, length)
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

function readZipDirectory(fd, fileSize) {
  const tailLength = Math.min(fileSize, 65_557)
  const tailOffset = fileSize - tailLength
  const tail = readBytesFromDescriptor(fd, tailOffset, tailLength)
  let eocdOffset = -1
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== ZIP_EOCD_SIGNATURE) continue
    const commentLength = tail.readUInt16LE(index + 20)
    if (index + 22 + commentLength === tail.length) {
      eocdOffset = index
      break
    }
  }
  if (eocdOffset < 0) throw new Error('release artifact ZIP directory is missing')
  const diskNumber = tail.readUInt16LE(eocdOffset + 4)
  const directoryDisk = tail.readUInt16LE(eocdOffset + 6)
  const diskEntries = tail.readUInt16LE(eocdOffset + 8)
  const entryCount = tail.readUInt16LE(eocdOffset + 10)
  const directorySize = tail.readUInt32LE(eocdOffset + 12)
  const directoryOffset = tail.readUInt32LE(eocdOffset + 16)
  const absoluteEocdOffset = tailOffset + eocdOffset
  if (
    diskNumber !== 0 ||
    directoryDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount > MAX_ZIP_ENTRIES ||
    directorySize > MAX_ZIP_DIRECTORY_BYTES ||
    directoryOffset + directorySize !== absoluteEocdOffset
  ) {
    throw new Error('release artifact ZIP directory is unsupported or oversized')
  }
  const directory = readBytesFromDescriptor(fd, directoryOffset, directorySize)
  if (directory.length !== directorySize) {
    throw new Error('release artifact ZIP directory is truncated')
  }
  const entries = []
  let cursor = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > directory.length ||
      directory.readUInt32LE(cursor) !== ZIP_CENTRAL_HEADER_SIGNATURE
    ) {
      throw new Error('release artifact ZIP entry is invalid')
    }
    const flags = directory.readUInt16LE(cursor + 8)
    const method = directory.readUInt16LE(cursor + 10)
    const compressedSize = directory.readUInt32LE(cursor + 20)
    const uncompressedSize = directory.readUInt32LE(cursor + 24)
    const nameLength = directory.readUInt16LE(cursor + 28)
    const extraLength = directory.readUInt16LE(cursor + 30)
    const commentLength = directory.readUInt16LE(cursor + 32)
    const startDisk = directory.readUInt16LE(cursor + 34)
    const localHeaderOffset = directory.readUInt32LE(cursor + 42)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (
      nameLength === 0 ||
      nameLength > 1_024 ||
      next > directory.length ||
      (flags & 1) !== 0 ||
      ![0, 8].includes(method) ||
      startDisk !== 0 ||
      [compressedSize, uncompressedSize, localHeaderOffset].includes(0xffffffff)
    ) {
      throw new Error('release artifact ZIP entry is unsupported')
    }
    const name = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    if (Buffer.byteLength(name, 'utf8') !== nameLength || /[\0\r\n\\]/.test(name)) {
      throw new Error('release artifact ZIP entry name is invalid')
    }
    entries.push({ name, flags, method, compressedSize, uncompressedSize, localHeaderOffset })
    cursor = next
  }
  if (cursor !== directory.length) {
    throw new Error('release artifact ZIP directory contains trailing data')
  }
  return entries
}

function readZipEntry(fd, fileSize, entry, maxBytes) {
  if (
    entry.uncompressedSize <= 0 ||
    entry.uncompressedSize > maxBytes ||
    entry.compressedSize <= 0 ||
    entry.compressedSize > maxBytes + 64 * 1024
  ) {
    throw new Error('release artifact ZIP entry is empty or oversized')
  }
  const header = readBytesFromDescriptor(fd, entry.localHeaderOffset, 30)
  if (header.length !== 30 || header.readUInt32LE(0) !== ZIP_LOCAL_HEADER_SIGNATURE) {
    throw new Error('release artifact ZIP local header is invalid')
  }
  const flags = header.readUInt16LE(6)
  const method = header.readUInt16LE(8)
  const nameLength = header.readUInt16LE(26)
  const extraLength = header.readUInt16LE(28)
  const nameBytes = readBytesFromDescriptor(fd, entry.localHeaderOffset + 30, nameLength)
  if (
    flags !== entry.flags ||
    method !== entry.method ||
    nameBytes.length !== nameLength ||
    nameBytes.toString('utf8') !== entry.name
  ) {
    throw new Error('release artifact ZIP local header does not match its directory')
  }
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength
  if (dataOffset + entry.compressedSize > fileSize) {
    throw new Error('release artifact ZIP entry data is truncated')
  }
  const compressed = readBytesFromDescriptor(fd, dataOffset, entry.compressedSize)
  if (compressed.length !== entry.compressedSize) {
    throw new Error('release artifact ZIP entry data is truncated')
  }
  const output =
    entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: maxBytes })
  if (output.length !== entry.uncompressedSize) {
    throw new Error('release artifact ZIP entry length is invalid')
  }
  return output
}

export function inspectReleaseZip(artifactPath, options = {}) {
  if (!SHA256_PATTERN.test(options.expectedSha256 ?? '')) {
    throw new Error('expected release artifact digest is invalid')
  }
  const fd = openSync(artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size <= 0 || info.size > MAX_RELEASE_BYTES) {
      throw new Error('release artifact ZIP is empty or oversized')
    }
    const entries = readZipDirectory(fd, info.size)
    const identityEntries = entries.filter(
      (entry) =>
        /^[^/\r\n]+\.app\/Contents\/Resources\/release-identity\.json$/.test(entry.name) &&
        entry.name.endsWith(RELEASE_IDENTITY_SUFFIX),
    )
    if (identityEntries.length !== 1) {
      throw new Error('release artifact must contain exactly one release identity')
    }
    const appRoot = identityEntries[0].name.slice(0, -RELEASE_IDENTITY_SUFFIX.length)
    const payloadName = `${appRoot}/${RELEASE_PAYLOAD_PATH}`
    const payloadEntries = entries.filter((entry) => entry.name === payloadName)
    if (payloadEntries.length !== 1) {
      throw new Error('release artifact must contain exactly one package payload')
    }
    const identityBytes = readZipEntry(
      fd,
      info.size,
      identityEntries[0],
      MAX_RELEASE_IDENTITY_BYTES,
    )
    const payloadBytes = readZipEntry(fd, info.size, payloadEntries[0], MAX_PACKAGE_PAYLOAD_BYTES)
    const identity = JSON.parse(identityBytes.toString('utf8'))
    const payloadSha256 = createHash('sha256').update(payloadBytes).digest('hex')
    if (fstatSync(fd).size !== info.size) {
      throw new Error('release artifact length changed during inspection')
    }
    const artifactSha256 = hashFileDescriptor(fd, info.size)
    if (fstatSync(fd).size !== info.size || artifactSha256 !== options.expectedSha256) {
      throw new Error('release artifact digest changed or does not match evidence')
    }
    return { identity, payloadSha256 }
  } finally {
    closeSync(fd)
  }
}

function assertFileKind(path, size, kind, expectedExtension, label, prefix) {
  const extension = extname(path).toLowerCase()
  if (kind === 'release') {
    if (extension !== '.zip' || !hasZipSignature(readBytes(path, 0, 4))) {
      fail(prefix, `${label} must be a ZIP file`)
    }
    return
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
  if (kind !== 'release' && hashFile(resolved) !== descriptor.sha256) {
    fail(prefix, `${label} digest mismatch`)
  }
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
  let releaseInspection
  try {
    releaseInspection = (options.inspectReleaseZip ?? inspectReleaseZip)(
      resolve(evidenceRoot, manifest.releaseArtifact.path),
      { expectedSha256: manifest.releaseArtifact.sha256 },
    )
  } catch {
    fail(prefix, 'release artifact identity is missing or invalid')
  }
  assertExactKeys(
    releaseInspection,
    ['identity', 'payloadSha256'],
    'release artifact inspection',
    prefix,
  )
  if (!SHA256_PATTERN.test(releaseInspection.payloadSha256)) {
    fail(prefix, 'release artifact inspected payload digest is invalid')
  }
  const releaseIdentity = releaseInspection.identity
  assertExactKeys(
    releaseIdentity,
    ['schemaVersion', 'productName', 'appId', 'version', 'sourceSha', 'packagePayload'],
    'release artifact identity',
    prefix,
  )
  assertExactKeys(
    releaseIdentity.packagePayload,
    ['path', 'sha256'],
    'release artifact package payload',
    prefix,
  )
  if (
    releaseIdentity.schemaVersion !== 1 ||
    releaseIdentity.productName !== 'Codexoffice' ||
    releaseIdentity.appId !== 'com.genoffice.app'
  ) {
    fail(prefix, 'release artifact identity does not describe Codexoffice')
  }
  assertBoundedText(releaseIdentity.version, 'release artifact version', prefix)
  if (!SOURCE_SHA_PATTERN.test(releaseIdentity.sourceSha)) {
    fail(prefix, 'release artifact source SHA is invalid')
  }
  if (releaseIdentity.sourceSha !== expectedSourceSha) {
    fail(prefix, 'release artifact source SHA does not match expected release source')
  }
  if (
    releaseIdentity.packagePayload.path !== RELEASE_PAYLOAD_PATH ||
    !SHA256_PATTERN.test(releaseIdentity.packagePayload.sha256)
  ) {
    fail(prefix, 'release artifact package payload identity is invalid')
  }
  if (releaseIdentity.packagePayload.sha256 !== releaseInspection.payloadSha256) {
    fail(prefix, 'release artifact package payload digest mismatch')
  }

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
