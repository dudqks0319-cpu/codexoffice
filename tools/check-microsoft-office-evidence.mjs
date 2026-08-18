import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultManifest = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../qa-artifacts/release-evidence/microsoft-office.json',
)
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/
const MAX_MANIFEST_BYTES = 1024 * 1024
const requiredAssertions = {
  word: ['noRepairPrompt', 'referencesPreserved', 'bidirectionalEditsPreserved', 'layoutReviewed'],
  excel: ['noRepairPrompt', 'formulasPreserved', 'chartsPreserved', 'stylesReviewed'],
  powerpoint: ['noRepairPrompt', 'mastersPreserved', 'mediaPreserved', 'visualLayoutReviewed'],
}

function fail(message) {
  throw new Error(`[office-evidence] ${message}`)
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function validateFile(evidenceRoot, descriptor, label) {
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
  const canonicalRoot = realpathSync(evidenceRoot)
  const canonicalResolved = realpathSync(resolved)
  const canonicalRel = relative(canonicalRoot, canonicalResolved)
  if (canonicalRel === '..' || canonicalRel.startsWith('../') || isAbsolute(canonicalRel)) {
    fail(`${label} resolves outside evidence root`)
  }
  if (sha256(resolved) !== descriptor.sha256) fail(`${label} digest mismatch`)
}

export function verifyMicrosoftOfficeEvidence(manifestPath = defaultManifest, options = {}) {
  const absoluteManifest = resolve(manifestPath)
  const evidenceRoot = dirname(absoluteManifest)
  const expectedSourceSha = options.expectedSourceSha?.trim().toLowerCase() ?? ''
  if (!SOURCE_SHA_PATTERN.test(expectedSourceSha)) fail('expected source SHA is missing or invalid')
  const evidenceRootInfo = lstatSync(evidenceRoot, { throwIfNoEntry: false })
  if (!evidenceRootInfo || evidenceRootInfo.isSymbolicLink() || !evidenceRootInfo.isDirectory()) {
    fail('evidence root is missing')
  }
  let manifest
  try {
    const manifestInfo = lstatSync(absoluteManifest, { throwIfNoEntry: false })
    if (
      !manifestInfo ||
      manifestInfo.isSymbolicLink() ||
      !manifestInfo.isFile() ||
      manifestInfo.size > MAX_MANIFEST_BYTES
    ) {
      fail('manifest is missing, unsafe, or oversized')
    }
    manifest = JSON.parse(readFileSync(absoluteManifest, 'utf8'))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('[office-evidence]')) throw error
    fail(error?.code === 'ENOENT' ? 'manifest is missing' : 'manifest is invalid JSON')
  }
  if (manifest.schemaVersion !== 1) fail('schemaVersion must be 1')
  if (!SOURCE_SHA_PATTERN.test(manifest.sourceSha)) fail('sourceSha is invalid')
  if (manifest.sourceSha !== expectedSourceSha)
    fail('sourceSha does not match expected release source')
  if (!Number.isFinite(Date.parse(manifest.testedAt))) fail('testedAt is invalid')
  if (
    typeof manifest.macosVersion !== 'string' ||
    !manifest.macosVersion.trim() ||
    manifest.macosVersion.length > 200
  ) {
    fail('macosVersion is missing')
  }
  validateFile(evidenceRoot, manifest.releaseArtifact, 'release artifact')

  for (const [appName, assertions] of Object.entries(requiredAssertions)) {
    const result = manifest.office?.[appName]
    if (!result || result.status !== 'PASS') fail(`${appName} status must be PASS`)
    if (
      typeof result.version !== 'string' ||
      !result.version.trim() ||
      result.version.length > 200
    ) {
      fail(`${appName} version is missing`)
    }
    validateFile(evidenceRoot, result.fixture, `${appName} fixture`)
    validateFile(evidenceRoot, result.savedDocument, `${appName} saved document`)
    if (
      !Array.isArray(result.screenshots) ||
      result.screenshots.length < 3 ||
      result.screenshots.length > 12
    ) {
      fail(`${appName} requires between three and twelve screenshots`)
    }
    if (
      new Set(result.screenshots.map((entry) => entry?.path)).size !== result.screenshots.length
    ) {
      fail(`${appName} screenshots must be distinct`)
    }
    result.screenshots.forEach((entry, index) =>
      validateFile(evidenceRoot, entry, `${appName} screenshot ${index + 1}`),
    )
    for (const assertion of assertions) {
      if (result.assertions?.[assertion] !== true) {
        fail(`${appName} assertion is incomplete: ${assertion}`)
      }
    }
  }

  return { sourceSha: manifest.sourceSha, testedAt: manifest.testedAt, status: 'PASS' }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const manifestPath = process.argv[2] ?? defaultManifest
    const result = verifyMicrosoftOfficeEvidence(manifestPath, {
      expectedSourceSha: process.env.GENOFFICE_SOURCE_SHA,
    })
    console.log(`[office-evidence] PASS source ${result.sourceSha} tested ${result.testedAt}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : '[office-evidence] verification failed')
    process.exitCode = 1
  }
}
