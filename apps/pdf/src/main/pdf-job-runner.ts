import { randomBytes, randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import type {
  PdfJobEnvelope,
  PdfJobReply,
  PdfTransformJob,
  PdfTransformResult,
} from '../shared/job'
import { pdfJobInputByteLength } from '../shared/job'
import {
  PDF_EDIT_MAX_PAGES,
  PDF_JOB_CHUNK_BYTES,
  PDF_MAX_EDIT_SOURCE_BYTES,
  PDF_MAX_JOB_INPUT_BYTES,
  PDF_MAX_JOB_OUTPUT_BYTES,
  PDF_MAX_JOB_REQUEST_BYTES,
} from '../shared/limits'

export interface PdfJobProcess {
  run(envelope: PdfJobEnvelope): Promise<unknown>
  destroy(force: boolean): void
}

export type PdfJobProcessFactory = () => PdfJobProcess | Promise<PdfJobProcess>

const bytesView = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
    return new Uint8Array(value as ArrayBuffer)
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    const raw = record.data ?? record.bytes
    if (Array.isArray(raw)) {
      if (
        raw.some(
          (entry) => !Number.isInteger(entry) || (entry as number) < 0 || (entry as number) > 255,
        )
      ) {
        return null
      }
      return Uint8Array.from(raw as number[])
    }
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return null
}

async function validateSource(path: string, byteLength: number, sha256: string): Promise<void> {
  if (
    !isAbsolute(path) ||
    !Number.isSafeInteger(byteLength) ||
    byteLength <= 0 ||
    byteLength > PDF_MAX_EDIT_SOURCE_BYTES ||
    !/^[a-f0-9]{64}$/.test(sha256)
  ) {
    throw new Error('pdf: isolated job source exceeds limit')
  }
  const info = await lstat(path).catch(() => null)
  if (!info || info.isSymbolicLink() || !info.isFile() || info.size !== byteLength) {
    throw new Error('pdf: isolated job source changed')
  }
}

async function validateJobInput(job: PdfTransformJob): Promise<void> {
  await validateSource(job.source.path, job.source.byteLength, job.source.sha256)
  if (job.kind === 'insert') {
    await validateSource(job.other.path, job.other.byteLength, job.other.sha256)
  }
  const input = pdfJobInputByteLength(job)
  if (
    input.requestBytes > PDF_MAX_JOB_REQUEST_BYTES ||
    input.totalBytes > PDF_MAX_JOB_INPUT_BYTES
  ) {
    throw new Error('pdf: isolated job input exceeds limit')
  }
}

function validateReply(
  raw: unknown,
  envelope: PdfJobEnvelope,
  maxOutputBytes: number,
): PdfTransformResult {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('pdf: invalid isolated job reply')
  }
  const reply = raw as Partial<PdfJobReply>
  if (reply.id !== envelope.id || reply.token !== envelope.token) {
    throw new Error('pdf: invalid isolated job reply')
  }
  if (reply.ok !== true) throw new Error('pdf: isolated transformation failed')
  if (
    !Number.isSafeInteger(reply.byteLength) ||
    (reply.byteLength as number) <= 0 ||
    !Number.isSafeInteger(reply.chunkCount) ||
    reply.chunkCount !== Math.ceil((reply.byteLength as number) / PDF_JOB_CHUNK_BYTES)
  ) {
    throw new Error('pdf: invalid isolated job reply')
  }
  if ((reply.byteLength as number) > maxOutputBytes) {
    throw new Error('pdf: isolated job output exceeds limit')
  }
  const output = bytesView(reply.bytes)
  if (!output || output.byteLength === 0 || output.byteLength > maxOutputBytes) {
    throw new Error('pdf: isolated job output exceeds limit')
  }
  if (output.byteLength !== reply.byteLength) throw new Error('pdf: invalid isolated job reply')
  if (envelope.job.kind === 'insert') {
    if (
      !Number.isSafeInteger(reply.insertedCount) ||
      (reply.insertedCount as number) < 0 ||
      (reply.insertedCount as number) > PDF_EDIT_MAX_PAGES
    ) {
      throw new Error('pdf: invalid isolated job reply')
    }
    return { bytes: output, insertedCount: reply.insertedCount }
  }
  return { bytes: output }
}

export async function executePdfJob(
  job: PdfTransformJob,
  options: {
    readonly createProcess: PdfJobProcessFactory
    readonly timeoutMs: number
    readonly id?: string
    readonly token?: string
    /** Test seam; production callers always use the shared hard ceiling. */
    readonly maxOutputBytes?: number
    readonly signal?: AbortSignal
  },
): Promise<PdfTransformResult> {
  await validateJobInput(job)
  if (options.signal?.aborted) throw new Error('pdf: isolated transformation canceled')
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs))
  const envelope: PdfJobEnvelope = {
    id: options.id ?? randomUUID(),
    token: options.token ?? randomBytes(32).toString('hex'),
    deadlineAt: Date.now() + timeoutMs,
    job,
  }
  const process = await options.createProcess()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortListener: (() => void) | undefined
  let force = false
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        force = true
        reject(new Error('pdf: isolated transformation timed out'))
      }, timeoutMs)
    })
    const canceled = new Promise<never>((_resolve, reject) => {
      if (!options.signal) return
      abortListener = () => {
        force = true
        reject(new Error('pdf: isolated transformation canceled'))
      }
      if (options.signal.aborted) {
        abortListener()
        return
      }
      options.signal.addEventListener('abort', abortListener, { once: true })
    })
    const raw = await Promise.race([process.run(envelope), timeout, canceled])
    return validateReply(raw, envelope, options.maxOutputBytes ?? PDF_MAX_JOB_OUTPUT_BYTES)
  } catch (error) {
    force = true
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    if (abortListener && options.signal) {
      options.signal.removeEventListener('abort', abortListener)
    }
    process.destroy(force)
  }
}

interface PendingJob {
  readonly createJob: (signal: AbortSignal) => PdfTransformJob | Promise<PdfTransformJob>
  readonly deadlineAt: number
  readonly resolve: (result: PdfTransformResult) => void
  readonly reject: (error: Error) => void
  readonly signal?: AbortSignal
  abortListener?: () => void
}

/** A bounded, absolute-deadline queue prevents hostile tabs from exhausting renderer memory. */
export class PdfJobQueue {
  private active = 0
  private readonly pending: PendingJob[] = []

  constructor(
    private readonly options: {
      readonly createProcess: PdfJobProcessFactory
      readonly timeoutMs?: number
      readonly maxConcurrent?: number
      readonly maxQueued?: number
    },
  ) {}

  run(job: PdfTransformJob): Promise<PdfTransformResult> {
    return this.runLazy(() => job)
  }

  /** Defer bounded file reads until this request owns an active slot. */
  runLazy(
    createJob: (signal: AbortSignal) => PdfTransformJob | Promise<PdfTransformJob>,
    signal?: AbortSignal,
  ): Promise<PdfTransformResult> {
    if (signal?.aborted) return Promise.reject(new Error('pdf: isolated transformation canceled'))
    const maxConcurrent = Math.max(1, this.options.maxConcurrent ?? 1)
    const maxQueued = Math.max(0, this.options.maxQueued ?? 4)
    if (this.active >= maxConcurrent && this.pending.length >= maxQueued) {
      return Promise.reject(new Error('pdf: isolated transformation queue is full'))
    }
    return new Promise((resolve, reject) => {
      const pending: PendingJob = {
        createJob,
        deadlineAt: Date.now() + Math.max(1, this.options.timeoutMs ?? 120_000),
        resolve,
        reject,
        signal,
      }
      if (signal) {
        pending.abortListener = () => {
          const index = this.pending.indexOf(pending)
          if (index < 0) return
          this.pending.splice(index, 1)
          reject(new Error('pdf: isolated transformation canceled'))
        }
        signal.addEventListener('abort', pending.abortListener, { once: true })
      }
      this.pending.push(pending)
      this.drain()
    })
  }

  private drain(): void {
    const maxConcurrent = Math.max(1, this.options.maxConcurrent ?? 1)
    while (this.active < maxConcurrent && this.pending.length > 0) {
      const next = this.pending.shift()!
      if (next.abortListener && next.signal) {
        next.signal.removeEventListener('abort', next.abortListener)
        next.abortListener = undefined
      }
      if (next.signal?.aborted) {
        next.reject(new Error('pdf: isolated transformation canceled'))
        continue
      }
      const remaining = next.deadlineAt - Date.now()
      if (remaining <= 0) {
        next.reject(new Error('pdf: isolated transformation timed out in queue'))
        continue
      }
      this.active += 1
      void this.executePending(next)
        .then(next.resolve, (error: unknown) =>
          next.reject(
            error instanceof Error ? error : new Error('pdf: isolated transformation failed'),
          ),
        )
        .finally(() => {
          this.active -= 1
          this.drain()
        })
    }
  }

  private async executePending(pending: PendingJob): Promise<PdfTransformResult> {
    let remaining = pending.deadlineAt - Date.now()
    if (remaining <= 0) throw new Error('pdf: isolated transformation timed out in queue')
    const controller = new AbortController()
    const cancelInput = () => controller.abort()
    pending.signal?.addEventListener('abort', cancelInput, { once: true })
    let inputTimer: ReturnType<typeof setTimeout> | undefined
    const inputTimeout = new Promise<never>((_resolve, reject) => {
      inputTimer = setTimeout(() => {
        controller.abort()
        reject(new Error('pdf: isolated transformation timed out while reading input'))
      }, remaining)
    })
    let job: PdfTransformJob
    try {
      job = await Promise.race([
        Promise.resolve().then(() => pending.createJob(controller.signal)),
        inputTimeout,
      ])
    } catch (error) {
      if (pending.signal?.aborted) {
        throw new Error('pdf: isolated transformation canceled', { cause: error })
      }
      if (controller.signal.aborted) {
        throw new Error('pdf: isolated transformation timed out while reading input', {
          cause: error,
        })
      }
      throw error
    } finally {
      if (inputTimer) clearTimeout(inputTimer)
      pending.signal?.removeEventListener('abort', cancelInput)
    }
    remaining = pending.deadlineAt - Date.now()
    if (remaining <= 0) {
      throw new Error('pdf: isolated transformation timed out while reading input')
    }
    return executePdfJob(job, {
      createProcess: this.options.createProcess,
      timeoutMs: remaining,
      signal: pending.signal,
    })
  }
}
