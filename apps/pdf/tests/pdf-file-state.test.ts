import { mkdtemp, rm, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  capturePdfDiskState,
  PDF_MAX_SOURCE_BYTES,
  pdfSourceChanged,
  readPdfWithState,
} from '../src/main/pdf-file-state'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'genoffice-pdf-state-'))
  cleanups.push(directory)
  const path = join(directory, 'source.pdf')
  await writeFile(path, '%PDF-original')
  return { directory, path }
}

describe('PDF source disk state', () => {
  it('accepts an unchanged source without rereading semantics leaking into the caller', async () => {
    const { path } = await fixture()
    const state = await capturePdfDiskState(path)
    await expect(pdfSourceChanged(state, path)).resolves.toBe(false)
  })

  it('ignores a timestamp-only touch after the content hash matches', async () => {
    const { path } = await fixture()
    const state = await capturePdfDiskState(path)
    const later = new Date(Date.now() + 5_000)
    await utimes(path, later, later)
    await expect(pdfSourceChanged(state, path)).resolves.toBe(false)
  })

  it('detects replacement bytes even when size and modification time are preserved', async () => {
    const { path } = await fixture()
    const state = await capturePdfDiskState(path)
    await writeFile(path, '%PDF-replaced')
    await utimes(path, new Date(state.mtimeMs), new Date(state.mtimeMs))

    await expect(pdfSourceChanged(state, path)).resolves.toBe(true)
  })

  it('detects replacement bytes and a deleted source', async () => {
    const { path } = await fixture()
    const state = await capturePdfDiskState(path)
    await writeFile(path, '%PDF-external-change')
    await expect(pdfSourceChanged(state, path)).resolves.toBe(true)
    await rm(path)
    await expect(pdfSourceChanged(state, path)).resolves.toBe(true)
  })

  it('fails closed when no baseline was recorded', async () => {
    const { path } = await fixture()
    await expect(pdfSourceChanged(undefined, path)).resolves.toBe(true)
  })

  it('rejects an oversized source before reading it into memory', async () => {
    const { path } = await fixture()
    await truncate(path, PDF_MAX_SOURCE_BYTES + 1)
    await expect(readPdfWithState(path)).rejects.toThrow('128MB safety limit')
    await expect(capturePdfDiskState(path)).rejects.toThrow('128MB safety limit')
  })
})
