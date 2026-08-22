import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'

import { PDF_MAX_SOURCE_BYTES } from '../shared/limits'

export interface PdfDiskState {
  readonly mtimeMs: number
  readonly size: number
  readonly sha256: string
}

export { PDF_MAX_SOURCE_BYTES } from '../shared/limits'

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function capturePdfDiskState(
  filePath: string,
  bytes?: Uint8Array,
): Promise<PdfDiskState> {
  if (bytes) {
    const info = await stat(filePath)
    if (info.size > PDF_MAX_SOURCE_BYTES || bytes.byteLength > PDF_MAX_SOURCE_BYTES) {
      throw new Error('pdf: file exceeds the 128MB safety limit')
    }
    if (bytes.byteLength !== info.size) throw new Error('pdf: source changed while hashing')
    return { mtimeMs: info.mtimeMs, size: info.size, sha256: sha256Bytes(bytes) }
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await stat(filePath)
    if (before.size > PDF_MAX_SOURCE_BYTES) {
      throw new Error('pdf: file exceeds the 128MB safety limit')
    }
    const hash = createHash('sha256')
    let bytesRead = 0
    for await (const chunk of createReadStream(filePath)) {
      hash.update(chunk)
      bytesRead += chunk.length
    }
    const after = await stat(filePath)
    if (
      before.mtimeMs === after.mtimeMs &&
      before.size === after.size &&
      bytesRead === after.size
    ) {
      return { mtimeMs: after.mtimeMs, size: after.size, sha256: hash.digest('hex') }
    }
  }
  throw new Error('pdf: source kept changing while it was being hashed')
}

/** Read bytes and their matching stat snapshot, retrying if a writer races the read. */
export async function readPdfWithState(
  filePath: string,
  signal?: AbortSignal,
  maxBytes = PDF_MAX_SOURCE_BYTES,
): Promise<{ bytes: Buffer; state: PdfDiskState }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await stat(filePath)
    if (before.size > maxBytes) {
      throw new Error(
        `pdf: file exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MB safety limit`,
      )
    }
    const bytes = signal ? await readFile(filePath, { signal }) : await readFile(filePath)
    const after = await stat(filePath)
    if (
      before.mtimeMs === after.mtimeMs &&
      before.size === after.size &&
      bytes.length === after.size
    ) {
      return {
        bytes,
        state: { mtimeMs: after.mtimeMs, size: after.size, sha256: sha256Bytes(bytes) },
      }
    }
  }
  throw new Error('pdf: source kept changing while it was being read')
}

/**
 * Detect another process replacing or rewriting the source after this view
 * loaded it. A timestamp-only change is ignored after the hash confirms the
 * bytes are identical. Missing/unreadable files fail closed as changed.
 */
export async function pdfSourceChanged(
  recorded: PdfDiskState | undefined,
  filePath: string,
): Promise<boolean> {
  if (!recorded) return true
  try {
    // Size/mtime are only hints: another app can preserve both while replacing
    // bytes. Integrity decisions therefore always compare a stable content hash.
    return (await capturePdfDiskState(filePath)).sha256 !== recorded.sha256
  } catch {
    return true
  }
}
