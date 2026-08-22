import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  readValidatedPdfJobOutput,
  stagePdfJobSources,
  writeCappedPdfJobOutput,
} from '../src/main/pdf-job-files'
import { sha256Bytes } from '../src/main/pdf-file-state'
import type { PdfTransformJob } from '../src/shared/job'

const temporary: string[] = []
const root = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'genoffice-pdf-job-files-'))
  temporary.push(path)
  return path
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

const saveJob = (path: string, byteLength: number): PdfTransformJob => ({
  kind: 'save',
  source: { path, byteLength, sha256: sha256Bytes(new Uint8Array([1, 2, 3, 4])) },
  request: { path: '/test.pdf', markups: [], drawings: [], formValues: [], stamps: [] },
})

describe('PDF job file broker', () => {
  it('copies source bytes through an owner-only staged file', async () => {
    const sourceRoot = root()
    const stagedRoot = root()
    const source = join(sourceRoot, 'source.pdf')
    writeFileSync(source, new Uint8Array([1, 2, 3, 4]))
    const staged = await stagePdfJobSources(saveJob(source, 4), stagedRoot)
    expect(readFileSync(staged.sourcePath)).toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it('rejects symlink inputs before reading document bytes', async () => {
    const sourceRoot = root()
    const stagedRoot = root()
    const target = join(sourceRoot, 'target.pdf')
    const link = join(sourceRoot, 'link.pdf')
    writeFileSync(target, new Uint8Array([1, 2, 3, 4]))
    symlinkSync(target, link)
    await expect(stagePdfJobSources(saveJob(link, 4), stagedRoot)).rejects.toThrow()
    expect(() => readFileSync(join(stagedRoot, 'source.pdf'))).toThrow()
  })

  it('rejects a declared length mismatch and removes the partial stage', async () => {
    const sourceRoot = root()
    const stagedRoot = root()
    const source = join(sourceRoot, 'source.pdf')
    writeFileSync(source, new Uint8Array([1, 2, 3, 4]))
    await expect(stagePdfJobSources(saveJob(source, 3), stagedRoot)).rejects.toThrow(/changed/)
    expect(() => readFileSync(join(stagedRoot, 'source.pdf'))).toThrow()
  })

  it('rejects same-length bytes that do not match the granted source hash', async () => {
    const sourceRoot = root()
    const stagedRoot = root()
    const source = join(sourceRoot, 'source.pdf')
    writeFileSync(source, new Uint8Array([4, 3, 2, 1]))
    await expect(stagePdfJobSources(saveJob(source, 4), stagedRoot)).rejects.toThrow(/changed/)
    expect(() => readFileSync(join(stagedRoot, 'source.pdf'))).toThrow()
  })

  it('streams bounded output and validates its final size', async () => {
    const stagedRoot = root()
    const output = join(stagedRoot, 'output.pdf')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.enqueue(new Uint8Array([3, 4]))
        controller.close()
      },
    })
    await expect(writeCappedPdfJobOutput(body, output, 4)).resolves.toBe(4)
    await expect(readValidatedPdfJobOutput(output, 4)).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4]),
    )
  })

  it('aborts and removes output before exceeding the cap', async () => {
    const stagedRoot = root()
    const output = join(stagedRoot, 'output.pdf')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.close()
      },
    })
    await expect(writeCappedPdfJobOutput(body, output, 2)).rejects.toThrow(/exceeds limit/)
    expect(() => readFileSync(output)).toThrow()
  })
})
