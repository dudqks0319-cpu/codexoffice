import { randomUUID } from 'node:crypto'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { atomicWrite } from './atomic-write'
import { replacePdfIfUnchanged } from './conditional-write'
import { prunePrivateArtifacts } from './private-artifacts'
import { readPdfWithState, sha256Bytes, type PdfDiskState } from './pdf-file-state'

interface PdfRecoveryManifestV1 {
  readonly version: 1
  readonly createdAt: number
  readonly baseState: PdfDiskState
  readonly recoverySha256: string
}

interface PdfRecoveryManifestV2 {
  readonly version: 2
  readonly generation: string
  readonly createdAt: number
  readonly baseState: PdfDiskState
  readonly recoverySha256: string
}

interface PdfRecoveryPointer {
  readonly version: 2
  readonly generation: string
}

type PdfRecoveryManifest = PdfRecoveryManifestV1 | PdfRecoveryManifestV2

export interface PdfRecoveryCandidate {
  readonly recoveryPath: string
  readonly manifestPath: string
  readonly baseState: PdfDiskState
  readonly recoverySha256: string
}

export type PdfRecoveryInspection =
  | { readonly kind: 'none' }
  | { readonly kind: 'recoverable'; readonly candidate: PdfRecoveryCandidate }
  | { readonly kind: 'source-changed'; readonly candidate: PdfRecoveryCandidate }

const keyFor = (sourcePath: string) => sha256Bytes(Buffer.from(sourcePath)).slice(0, 24)

/** Legacy v1 paths; the JSON path is also the atomic v2 current-generation pointer. */
export function pdfRecoveryPaths(
  recoveryRoot: string,
  sourcePath: string,
): { readonly recoveryPath: string; readonly manifestPath: string } {
  const key = keyFor(sourcePath)
  return {
    recoveryPath: join(recoveryRoot, `${key}.pdf`),
    manifestPath: join(recoveryRoot, `${key}.json`),
  }
}

const generationPaths = (recoveryRoot: string, sourcePath: string, generation: string) => {
  const prefix = `${keyFor(sourcePath)}-${generation}`
  return {
    recoveryPath: join(recoveryRoot, `${prefix}.pdf`),
    manifestPath: join(recoveryRoot, `${prefix}.json`),
  }
}

const isGeneration = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9-]{16,64}$/.test(value)

const isDiskState = (value: unknown): value is PdfDiskState => {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Record<string, unknown>
  return (
    typeof state.mtimeMs === 'number' &&
    Number.isFinite(state.mtimeMs) &&
    typeof state.size === 'number' &&
    Number.isSafeInteger(state.size) &&
    state.size >= 0 &&
    typeof state.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(state.sha256)
  )
}

const parseManifest = (raw: string): PdfRecoveryManifest | null => {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const manifest = value as Record<string, unknown>
  const commonValid =
    typeof manifest.createdAt === 'number' &&
    Number.isFinite(manifest.createdAt) &&
    isDiskState(manifest.baseState) &&
    typeof manifest.recoverySha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(manifest.recoverySha256)
  if (!commonValid) return null
  if (manifest.version === 1) return manifest as unknown as PdfRecoveryManifestV1
  if (manifest.version === 2 && isGeneration(manifest.generation)) {
    return manifest as unknown as PdfRecoveryManifestV2
  }
  return null
}

const parsePointer = (raw: string): PdfRecoveryPointer | null => {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const pointer = value as Record<string, unknown>
  return pointer.version === 2 && isGeneration(pointer.generation)
    ? { version: 2, generation: pointer.generation }
    : null
}

async function validatedCandidate(
  recoveryPath: string,
  manifestPath: string,
  expectedGeneration?: string,
): Promise<PdfRecoveryCandidate | null> {
  try {
    const manifest = parseManifest(await readFile(manifestPath, 'utf8'))
    if (!manifest) return null
    if (
      expectedGeneration !== undefined &&
      (manifest.version !== 2 || manifest.generation !== expectedGeneration)
    ) {
      return null
    }
    const recoverySha256 = (await readPdfWithState(recoveryPath)).state.sha256
    if (recoverySha256 !== manifest.recoverySha256) return null
    return {
      recoveryPath,
      manifestPath,
      baseState: manifest.baseState,
      recoverySha256: manifest.recoverySha256,
    }
  } catch {
    return null
  }
}

async function currentCandidate(
  recoveryRoot: string,
  sourcePath: string,
): Promise<PdfRecoveryCandidate | null> {
  const legacy = pdfRecoveryPaths(recoveryRoot, sourcePath)
  // A generation is self-validating. Prefer the newest complete pair even if a
  // crash happened after it was written but just before the pointer advanced.
  const keyPrefix = `${keyFor(sourcePath)}-`
  const manifests = (await readdir(recoveryRoot, { withFileTypes: true }).catch(() => [])).filter(
    (entry) => entry.isFile() && entry.name.startsWith(keyPrefix) && entry.name.endsWith('.json'),
  )
  const newest = (
    await Promise.all(
      manifests.map(async (entry) => {
        const path = join(recoveryRoot, entry.name)
        return { path, mtimeMs: (await stat(path)).mtimeMs }
      }),
    )
  ).sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const entry of newest) {
    const generation = basename(entry.path, '.json').slice(keyPrefix.length)
    if (!isGeneration(generation)) continue
    const paths = generationPaths(recoveryRoot, sourcePath, generation)
    const candidate = await validatedCandidate(paths.recoveryPath, paths.manifestPath, generation)
    if (candidate) return candidate
  }

  try {
    const raw = await readFile(legacy.manifestPath, 'utf8')
    const pointer = parsePointer(raw)
    if (pointer) {
      const paths = generationPaths(recoveryRoot, sourcePath, pointer.generation)
      return validatedCandidate(paths.recoveryPath, paths.manifestPath, pointer.generation)
    }
    if (parseManifest(raw)?.version === 1) {
      return validatedCandidate(legacy.recoveryPath, legacy.manifestPath)
    }
  } catch {
    // No legacy or pointed candidate remains.
  }
  return null
}

/** Persist a new generation before atomically advancing the current pointer. */
export async function writePdfRecovery(args: {
  readonly recoveryRoot: string
  readonly sourcePath: string
  readonly baseState: PdfDiskState
  readonly editedBytes: Uint8Array
  readonly hooks?: { readonly beforePointerCommit?: () => Promise<void> }
}): Promise<PdfRecoveryCandidate> {
  const generation = randomUUID()
  const paths = generationPaths(args.recoveryRoot, args.sourcePath, generation)
  const pointerPath = pdfRecoveryPaths(args.recoveryRoot, args.sourcePath).manifestPath
  const active = await currentCandidate(args.recoveryRoot, args.sourcePath)
  const manifest: PdfRecoveryManifestV2 = {
    version: 2,
    generation,
    createdAt: Date.now(),
    baseState: args.baseState,
    recoverySha256: sha256Bytes(args.editedBytes),
  }
  await prunePrivateArtifacts(args.recoveryRoot, {
    keepPaths: [
      pointerPath,
      paths.recoveryPath,
      paths.manifestPath,
      ...(active ? [active.recoveryPath, active.manifestPath] : []),
    ],
    maxFiles: 96,
    maxBytes: 512 * 1024 * 1024,
    maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
    reserveBytes: args.editedBytes.byteLength + 8 * 1024,
  })
  await atomicWrite(paths.recoveryPath, args.editedBytes, { private: true })
  await atomicWrite(paths.manifestPath, Buffer.from(JSON.stringify(manifest)), { private: true })
  await args.hooks?.beforePointerCommit?.()
  await atomicWrite(
    pointerPath,
    Buffer.from(JSON.stringify({ version: 2, generation } satisfies PdfRecoveryPointer)),
    { private: true },
  )
  if (active && active.recoveryPath !== paths.recoveryPath) {
    await Promise.all([
      rm(active.recoveryPath, { force: true }),
      ...(active.manifestPath === pointerPath ? [] : [rm(active.manifestPath, { force: true })]),
    ])
  }
  return { ...paths, baseState: manifest.baseState, recoverySha256: manifest.recoverySha256 }
}

export async function clearPdfRecovery(recoveryRoot: string, sourcePath: string): Promise<void> {
  const key = keyFor(sourcePath)
  const entries = await readdir(recoveryRoot, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          (entry.name === `${key}.pdf` ||
            entry.name === `${key}.json` ||
            entry.name.startsWith(`${key}-`)),
      )
      .map((entry) => rm(join(recoveryRoot, entry.name), { force: true })),
  )
}

/** Never restore over a source whose content hash changed after recovery creation. */
export async function inspectPdfRecovery(
  recoveryRoot: string,
  sourcePath: string,
  currentState: PdfDiskState,
): Promise<PdfRecoveryInspection> {
  const candidate = await currentCandidate(recoveryRoot, sourcePath)
  if (!candidate) {
    await clearPdfRecovery(recoveryRoot, sourcePath)
    return { kind: 'none' }
  }
  if (currentState.sha256 === candidate.recoverySha256) {
    await clearPdfRecovery(recoveryRoot, sourcePath)
    return { kind: 'none' }
  }
  return currentState.sha256 === candidate.baseState.sha256
    ? { kind: 'recoverable', candidate }
    : { kind: 'source-changed', candidate }
}

export async function restorePdfRecovery(
  sourcePath: string,
  candidate: PdfRecoveryCandidate,
): Promise<void> {
  const recovered = await readPdfWithState(candidate.recoveryPath)
  if (recovered.state.sha256 !== candidate.recoverySha256) {
    throw new Error('pdf: recovery changed before restore')
  }
  const result = await replacePdfIfUnchanged({
    sourcePath,
    expectedState: candidate.baseState,
    replacementBytes: recovered.bytes,
  })
  if (result.kind === 'changed') {
    throw new Error('pdf: source changed before recovery restore')
  }
}
