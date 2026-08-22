import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { executePdfJob, PdfJobQueue } from '../src/main/pdf-job-runner'
import { sha256Bytes } from '../src/main/pdf-file-state'
import type { PdfJobProcess } from '../src/main/pdf-job-runner'
import type { PdfJobEnvelope, PdfTransformJob } from '../src/shared/job'

const root = mkdtempSync(join(tmpdir(), 'genoffice-pdf-job-runner-'))
const sourcePath = join(root, 'source.pdf')
writeFileSync(sourcePath, new Uint8Array([0x25, 0x50, 0x44, 0x46]))

afterAll(() => rmSync(root, { recursive: true, force: true }))

const saveJob = (): PdfTransformJob => ({
  kind: 'save',
  source: {
    path: sourcePath,
    byteLength: 4,
    sha256: sha256Bytes(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
  },
  request: {
    path: '/test.pdf',
    markups: [],
    drawings: [],
    formValues: [],
    stamps: [],
  },
})

const success = (envelope: PdfJobEnvelope, bytes = new Uint8Array([1])) => ({
  id: envelope.id,
  token: envelope.token,
  ok: true as const,
  bytes,
  byteLength: bytes.byteLength,
  chunkCount: 1,
})

describe('isolated PDF job runner', () => {
  it('force-destroys a process that exceeds the whole-operation deadline', async () => {
    const process: PdfJobProcess = {
      run: () => new Promise(() => undefined),
      destroy: vi.fn(),
    }
    await expect(
      executePdfJob(saveJob(), { createProcess: () => process, timeoutMs: 5 }),
    ).rejects.toThrow(/timed out/)
    expect(process.destroy).toHaveBeenCalledWith(true)
  })

  it('rejects a reply with the wrong capability token and force-destroys the process', async () => {
    const process: PdfJobProcess = {
      run: async (envelope) => ({ ...success(envelope), token: 'wrong-token' }),
      destroy: vi.fn(),
    }
    await expect(
      executePdfJob(saveJob(), { createProcess: () => process, timeoutMs: 100 }),
    ).rejects.toThrow(/invalid isolated job reply/)
    expect(process.destroy).toHaveBeenCalledWith(true)
  })

  it('rejects output beyond the configured hard ceiling', async () => {
    const process: PdfJobProcess = {
      run: async (envelope) => success(envelope, new Uint8Array([1, 2, 3])),
      destroy: vi.fn(),
    }
    await expect(
      executePdfJob(saveJob(), {
        createProcess: () => process,
        timeoutMs: 100,
        maxOutputBytes: 2,
      }),
    ).rejects.toThrow(/output exceeds limit/)
    expect(process.destroy).toHaveBeenCalledWith(true)
  })

  it('force-destroys the active process when its owner cancels', async () => {
    const controller = new AbortController()
    const process: PdfJobProcess = {
      run: vi.fn(() => new Promise(() => undefined)),
      destroy: vi.fn(),
    }
    const pending = executePdfJob(saveJob(), {
      createProcess: () => process,
      timeoutMs: 1_000,
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(process.run).toHaveBeenCalledOnce())
    controller.abort()
    await expect(pending).rejects.toThrow(/canceled/)
    expect(process.destroy).toHaveBeenCalledWith(true)
  })

  it('bounds concurrency and rejects work beyond the queue limit', async () => {
    const releases: Array<() => void> = []
    const createProcess = vi.fn((): PdfJobProcess => ({
      run: (envelope) =>
        new Promise((resolve) => {
          releases.push(() => resolve(success(envelope)))
        }),
      destroy: vi.fn(),
    }))
    const queue = new PdfJobQueue({
      createProcess,
      timeoutMs: 1_000,
      maxConcurrent: 1,
      maxQueued: 1,
    })

    const first = queue.run(saveJob())
    const second = queue.run(saveJob())
    await expect(queue.run(saveJob())).rejects.toThrow(/queue is full/)
    await vi.waitFor(() => expect(createProcess).toHaveBeenCalledTimes(1))

    releases.shift()!()
    await expect(first).resolves.toMatchObject({ bytes: new Uint8Array([1]) })
    await vi.waitFor(() => expect(createProcess).toHaveBeenCalledTimes(2))
    releases.shift()!()
    await expect(second).resolves.toMatchObject({ bytes: new Uint8Array([1]) })
  })

  it('aborts a deferred input read at the absolute queue deadline', async () => {
    let observedSignal: AbortSignal | undefined
    const queue = new PdfJobQueue({
      createProcess: () => {
        throw new Error('process must not start')
      },
      timeoutMs: 5,
      maxConcurrent: 1,
      maxQueued: 0,
    })

    await expect(
      queue.runLazy(
        (signal) =>
          new Promise((_resolve, reject) => {
            observedSignal = signal
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          }),
      ),
    ).rejects.toThrow(/timed out while reading input/)
    expect(observedSignal?.aborted).toBe(true)
  })
})
