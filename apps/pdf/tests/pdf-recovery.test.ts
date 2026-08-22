import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { PDFArray, PDFDocument, PDFName } from 'pdf-lib'

import {
  clearPdfRecovery,
  inspectPdfRecovery,
  restorePdfRecovery,
  writePdfRecovery,
} from '../src/main/pdf-recovery'
import { readPdfWithState } from '../src/main/pdf-file-state'
import { applySaveRequest } from '../src/main/save-pdf'
import type { SavePdfRequest } from '../src/shared/ipc'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function makePdf(width = 200): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([width, 200])
  return doc.save({ useObjectStreams: false })
}

const request = (path: string): SavePdfRequest => ({
  path,
  markups: [],
  drawings: [
    {
      kind: 'rect',
      pageIndex: 0,
      color: [1, 0, 0],
      width: 2,
      rect: [10, 10, 80, 80],
    },
  ],
  formValues: [],
  stamps: [],
})

async function annotationCount(path: string): Promise<number> {
  const doc = await PDFDocument.load(new Uint8Array(await readFile(path)))
  return doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.size() ?? 0
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'genoffice-pdf-recovery-'))
  cleanups.push(directory)
  const sourcePath = join(directory, 'source.pdf')
  const snapshotPath = join(directory, 'snapshot.pdf')
  const recoveryRoot = join(directory, 'recovery')
  const original = await makePdf()
  await writeFile(sourcePath, original)
  await writeFile(snapshotPath, original)
  return { directory, sourcePath, snapshotPath, recoveryRoot, original }
}

describe('PDF crash recovery', () => {
  it('restores an edited recovery only while the original source is unchanged', async () => {
    const paths = await fixture()
    const base = await readPdfWithState(paths.sourcePath)
    const candidate = await writePdfRecovery({
      ...paths,
      baseState: base.state,
      editedBytes: await applySaveRequest(paths.original, request(paths.sourcePath)),
    })

    const inspection = await inspectPdfRecovery(
      paths.recoveryRoot,
      paths.sourcePath,
      (await readPdfWithState(paths.sourcePath)).state,
    )
    expect(inspection).toEqual({ kind: 'recoverable', candidate })
    await restorePdfRecovery(paths.sourcePath, candidate)
    expect(await annotationCount(paths.sourcePath)).toBe(1)
    await clearPdfRecovery(paths.recoveryRoot, paths.sourcePath)
    await expect(
      inspectPdfRecovery(
        paths.recoveryRoot,
        paths.sourcePath,
        (await readPdfWithState(paths.sourcePath)).state,
      ),
    ).resolves.toEqual({ kind: 'none' })
  })

  it('keeps a recovery copy and refuses restore after an external source replacement', async () => {
    const paths = await fixture()
    const base = await readPdfWithState(paths.sourcePath)
    const candidate = await writePdfRecovery({
      ...paths,
      baseState: base.state,
      editedBytes: await applySaveRequest(paths.original, request(paths.sourcePath)),
    })
    await writeFile(paths.sourcePath, await makePdf(400))

    const inspection = await inspectPdfRecovery(
      paths.recoveryRoot,
      paths.sourcePath,
      (await readPdfWithState(paths.sourcePath)).state,
    )
    expect(inspection).toEqual({ kind: 'source-changed', candidate })
    await expect(restorePdfRecovery(paths.sourcePath, candidate)).rejects.toThrow(
      'source changed before recovery restore',
    )
    expect(await annotationCount(candidate.recoveryPath)).toBe(1)
    expect(
      (await PDFDocument.load(new Uint8Array(await readFile(paths.sourcePath))))
        .getPage(0)
        .getWidth(),
    ).toBe(400)
  })

  it('drops a torn recovery whose manifest hash does not match its PDF', async () => {
    const paths = await fixture()
    const base = await readPdfWithState(paths.sourcePath)
    const candidate = await writePdfRecovery({
      ...paths,
      baseState: base.state,
      editedBytes: await applySaveRequest(paths.original, request(paths.sourcePath)),
    })
    await writeFile(candidate.recoveryPath, await makePdf(500))

    await expect(
      inspectPdfRecovery(paths.recoveryRoot, paths.sourcePath, base.state),
    ).resolves.toEqual({ kind: 'none' })
    await expect(readFile(candidate.recoveryPath)).rejects.toThrow()
  })

  it('recovers the newest complete generation if a crash occurs before pointer commit', async () => {
    const paths = await fixture()
    const base = await readPdfWithState(paths.sourcePath)
    await writePdfRecovery({
      ...paths,
      baseState: base.state,
      editedBytes: await applySaveRequest(paths.original, request(paths.sourcePath)),
    })
    const second = await makePdf(600)

    await expect(
      writePdfRecovery({
        ...paths,
        baseState: base.state,
        editedBytes: second,
        hooks: { beforePointerCommit: async () => Promise.reject(new Error('simulated crash')) },
      }),
    ).rejects.toThrow('simulated crash')

    const inspection = await inspectPdfRecovery(paths.recoveryRoot, paths.sourcePath, base.state)
    expect(inspection.kind).toBe('recoverable')
    if (inspection.kind !== 'recoverable') throw new Error('expected recoverable generation')
    expect(
      (await PDFDocument.load(new Uint8Array(await readFile(inspection.candidate.recoveryPath))))
        .getPage(0)
        .getWidth(),
    ).toBe(600)
  })
})
