import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, open, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { PdfJobFileSource, PdfTransformJob } from '../shared/job'
import {
  PDF_MAX_EDIT_SOURCE_BYTES,
  PDF_MAX_JOB_INPUT_BYTES,
  PDF_MAX_JOB_OUTPUT_BYTES,
} from '../shared/limits'

const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0

async function copySource(
  source: PdfJobFileSource,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const input = await open(source.path, constants.O_RDONLY | noFollow)
  const output = await open(destination, 'wx', 0o600)
  let complete = false
  try {
    const before = await input.stat()
    if (
      !before.isFile() ||
      before.size !== source.byteLength ||
      before.size <= 0 ||
      before.size > PDF_MAX_EDIT_SOURCE_BYTES
    ) {
      throw new Error('pdf: isolated job source changed')
    }
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    const hash = createHash('sha256')
    let offset = 0
    while (offset < before.size) {
      if (signal?.aborted) throw new Error('pdf: isolated transformation canceled')
      const { bytesRead } = await input.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - offset),
        offset,
      )
      if (bytesRead <= 0) throw new Error('pdf: isolated job source changed')
      hash.update(buffer.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written)
        written += result.bytesWritten
      }
      offset += bytesRead
    }
    const after = await input.stat()
    if (
      offset !== source.byteLength ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error('pdf: isolated job source changed')
    }
    if (hash.digest('hex') !== source.sha256) {
      throw new Error('pdf: isolated job source changed')
    }
    await output.sync()
    complete = true
  } finally {
    await Promise.all([input.close().catch(() => undefined), output.close().catch(() => undefined)])
    if (!complete) await rm(destination, { force: true })
  }
  await chmod(destination, 0o600)
}

export interface StagedPdfJobSources {
  readonly sourcePath: string
  readonly otherPath?: string
}

/** Copy bounded input through fixed-size buffers; main never materializes a whole PDF. */
export async function stagePdfJobSources(
  job: PdfTransformJob,
  root: string,
  signal?: AbortSignal,
): Promise<StagedPdfJobSources> {
  if (
    job.source.byteLength + (job.kind === 'insert' ? job.other.byteLength : 0) >
    PDF_MAX_JOB_INPUT_BYTES
  ) {
    throw new Error('pdf: isolated job input exceeds limit')
  }
  const sourcePath = join(root, 'source.pdf')
  await copySource(job.source, sourcePath, signal)
  if (job.kind !== 'insert') return { sourcePath }
  const otherPath = join(root, 'other.pdf')
  try {
    await copySource(job.other, otherPath, signal)
    return { sourcePath, otherPath }
  } catch (error) {
    await rm(sourcePath, { force: true })
    throw error
  }
}

/** Stream an untrusted sandbox response into an exclusive owner-only file. */
export async function writeCappedPdfJobOutput(
  body: ReadableStream<Uint8Array> | null,
  outputPath: string,
  maximumBytes = PDF_MAX_JOB_OUTPUT_BYTES,
): Promise<number> {
  if (!body) throw new Error('pdf: isolated job output is missing')
  const handle = await open(outputPath, 'wx', 0o600)
  const reader = body.getReader()
  let total = 0
  let complete = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!(value instanceof Uint8Array) || value.byteLength === 0) continue
      total += value.byteLength
      if (total > maximumBytes) throw new Error('pdf: isolated job output exceeds limit')
      let written = 0
      while (written < value.byteLength) {
        const result = await handle.write(value, written, value.byteLength - written)
        written += result.bytesWritten
      }
    }
    if (total === 0) throw new Error('pdf: isolated job output is missing')
    await handle.sync()
    complete = true
    return total
  } finally {
    await reader.cancel().catch(() => undefined)
    await handle.close().catch(() => undefined)
    if (!complete) await rm(outputPath, { force: true })
    else await chmod(outputPath, 0o600)
  }
}

export async function readValidatedPdfJobOutput(
  outputPath: string,
  expectedBytes: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes <= 0 ||
    expectedBytes > PDF_MAX_JOB_OUTPUT_BYTES
  ) {
    throw new Error('pdf: isolated job output exceeds limit')
  }
  const handle = await open(outputPath, constants.O_RDONLY | noFollow)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size !== expectedBytes) {
      throw new Error('pdf: invalid isolated job output')
    }
    return new Uint8Array(await handle.readFile())
  } finally {
    await handle.close()
  }
}
