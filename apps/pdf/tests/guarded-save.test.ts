import { createHash } from 'node:crypto'
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { PDFArray, PDFDocument, PDFName } from 'pdf-lib'

import { savePdfWithSourceGuard } from '../src/main/guarded-save'
import { repairInterruptedPdfCommitSync } from '../src/main/conditional-write'
import { capturePdfDiskState } from '../src/main/pdf-file-state'
import { applySaveRequest } from '../src/main/save-pdf'
import type { SavePdfRequest } from '../src/shared/ipc'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function makePdf(width: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([width, 200])
  return doc.save({ useObjectStreams: false })
}

const request = (path: string): SavePdfRequest => ({
  path,
  markups: [
    {
      pageIndex: 0,
      type: 'highlight',
      color: [1, 0.87, 0.35],
      quads: [[10, 100, 60, 100, 10, 88, 60, 88]],
    },
  ],
  drawings: [],
  formValues: [],
  stamps: [],
})

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function annotationCount(path: string): Promise<number> {
  const doc = await PDFDocument.load(new Uint8Array(await readFile(path)))
  return doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.size() ?? 0
}

describe('guarded PDF save', () => {
  it('replaces an unchanged source with the edited bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'genoffice-pdf-guard-'))
    cleanups.push(directory)
    const sourcePath = join(directory, 'source.pdf')
    const recoveryPath = join(directory, 'recovery.pdf')
    const original = await makePdf(200)
    await chmod(directory, 0o775)
    await writeFile(sourcePath, original)
    const diskState = await capturePdfDiskState(sourcePath, original)

    await expect(
      savePdfWithSourceGuard({
        sourcePath,
        targetPath: sourcePath,
        recoveryPath,
        diskState,
        editedBytes: await applySaveRequest(original, request(sourcePath)),
      }),
    ).resolves.toEqual({ kind: 'saved' })
    expect(await annotationCount(sourcePath)).toBe(1)
    expect((await stat(directory)).mode & 0o777).toBe(0o775)
    await expect(readFile(recoveryPath)).rejects.toThrow()
    expect((await readdir(directory)).some((name) => name.includes('.genoffice-claim-'))).toBe(true)
  })

  it('keeps an externally replaced source and writes the edited snapshot to recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'genoffice-pdf-guard-'))
    cleanups.push(directory)
    const sourcePath = join(directory, 'source.pdf')
    const snapshotPath = join(directory, 'snapshot.pdf')
    const recoveryPath = join(directory, 'recovery.pdf')
    const original = await makePdf(200)
    await writeFile(sourcePath, original)
    await writeFile(snapshotPath, original)
    const diskState = await capturePdfDiskState(sourcePath, original)

    const external = await makePdf(400)
    await writeFile(sourcePath, external)
    const result = await savePdfWithSourceGuard({
      sourcePath,
      targetPath: sourcePath,
      recoveryPath,
      diskState,
      editedBytes: await applySaveRequest(original, request(sourcePath)),
    })

    expect(result).toEqual({ kind: 'source-changed', recoveryPath })
    expect(hash(await readFile(sourcePath))).toBe(hash(external))
    expect(await annotationCount(sourcePath)).toBe(0)
    expect(await annotationCount(recoveryPath)).toBe(1)
    expect(
      (await PDFDocument.load(new Uint8Array(await readFile(recoveryPath)))).getPage(0).getWidth(),
    ).toBe(200)
  })

  it('builds Save As from the viewed snapshot even after the live source changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'genoffice-pdf-guard-'))
    cleanups.push(directory)
    const sourcePath = join(directory, 'source.pdf')
    const snapshotPath = join(directory, 'snapshot.pdf')
    const targetPath = join(directory, 'copy.pdf')
    const original = await makePdf(200)
    await writeFile(sourcePath, original)
    await writeFile(snapshotPath, original)
    const diskState = await capturePdfDiskState(sourcePath, original)
    const external = await makePdf(400)
    await writeFile(sourcePath, external)

    await expect(
      savePdfWithSourceGuard({
        sourcePath,
        targetPath,
        recoveryPath: join(directory, 'unused.pdf'),
        diskState,
        editedBytes: await applySaveRequest(original, request(sourcePath)),
      }),
    ).resolves.toEqual({ kind: 'saved' })

    expect(hash(await readFile(sourcePath))).toBe(hash(external))
    expect(
      (await PDFDocument.load(new Uint8Array(await readFile(targetPath)))).getPage(0).getWidth(),
    ).toBe(200)
    expect(await annotationCount(targetPath)).toBe(1)
  })

  it('preserves an external replacement that lands after the pre-check but before claim', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'genoffice-pdf-guard-race-'))
    cleanups.push(directory)
    const sourcePath = join(directory, 'source.pdf')
    const recoveryPath = join(directory, 'recovery.pdf')
    const original = await makePdf(200)
    const external = await makePdf(500)
    await writeFile(sourcePath, original)
    const diskState = await capturePdfDiskState(sourcePath, original)

    const result = await savePdfWithSourceGuard({
      sourcePath,
      targetPath: sourcePath,
      recoveryPath,
      diskState,
      editedBytes: await applySaveRequest(original, request(sourcePath)),
      hooks: { beforeClaim: () => writeFile(sourcePath, external) },
    })

    expect(result).toEqual({ kind: 'source-changed', recoveryPath })
    expect(hash(await readFile(sourcePath))).toBe(hash(external))
    expect(await annotationCount(sourcePath)).toBe(0)
    expect(await annotationCount(recoveryPath)).toBe(1)
    expect((await readdir(directory)).some((name) => name.includes('.genoffice-claim-'))).toBe(true)
  })

  it('never deletes a newer external replacement that lands after install', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'genoffice-pdf-guard-race-'))
    cleanups.push(directory)
    const sourcePath = join(directory, 'source.pdf')
    const recoveryPath = join(directory, 'recovery.pdf')
    const original = await makePdf(200)
    const newestExternal = await makePdf(700)
    await writeFile(sourcePath, original)
    const diskState = await capturePdfDiskState(sourcePath, original)

    const result = await savePdfWithSourceGuard({
      sourcePath,
      targetPath: sourcePath,
      recoveryPath,
      diskState,
      editedBytes: await applySaveRequest(original, request(sourcePath)),
      hooks: { afterInstall: () => writeFile(sourcePath, newestExternal) },
    })

    expect(result.kind).toBe('source-changed')
    expect(hash(await readFile(sourcePath))).toBe(hash(newestExternal))
    expect(await annotationCount(recoveryPath)).toBe(1)
    expect((await readdir(directory)).some((name) => name.includes('.genoffice-claim-'))).toBe(true)
  })

  it('repairs a source pathname left between claim and install without overwriting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'genoffice-pdf-guard-crash-'))
    cleanups.push(directory)
    const sourcePath = join(directory, 'source.pdf')
    const claimPath = `${sourcePath}.genoffice-claim-crash-fixture`
    const journalPath = `${sourcePath}.genoffice-commit.json`
    const original = await makePdf(321)
    await writeFile(sourcePath, original)
    await rename(sourcePath, claimPath)
    await writeFile(
      journalPath,
      JSON.stringify({ version: 1, pid: 999_999, sourcePath, claimPath }),
      { mode: 0o600 },
    )

    expect(repairInterruptedPdfCommitSync(sourcePath)).toBe(true)
    expect(hash(await readFile(sourcePath))).toBe(hash(original))
    expect(hash(await readFile(claimPath))).toBe(hash(original))
    await expect(readFile(journalPath)).rejects.toThrow()
  })

  it('repairs a canonical target reopened through its dangling symlink alias', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'genoffice-pdf-guard-symlink-'))
    cleanups.push(directory)
    const sourcePath = join(directory, 'source.pdf')
    const aliasPath = join(directory, 'alias.pdf')
    const claimPath = `${sourcePath}.genoffice-claim-crash-fixture`
    const journalPath = `${sourcePath}.genoffice-commit.json`
    const original = await makePdf(444)
    await writeFile(sourcePath, original)
    await symlink(sourcePath, aliasPath)
    await rename(sourcePath, claimPath)
    await writeFile(
      journalPath,
      JSON.stringify({ version: 1, pid: 999_999, sourcePath, claimPath }),
      { mode: 0o600 },
    )

    expect(repairInterruptedPdfCommitSync(aliasPath)).toBe(true)
    expect(hash(await readFile(aliasPath))).toBe(hash(original))
  })

  it('durably writes the exact repair journal before moving the source path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'genoffice-pdf-guard-journal-'))
    cleanups.push(directory)
    const sourcePath = join(directory, 'source.pdf')
    const recoveryPath = join(directory, 'recovery.pdf')
    const journalPath = `${sourcePath}.genoffice-commit.json`
    const original = await makePdf(222)
    await writeFile(sourcePath, original)
    const diskState = await capturePdfDiskState(sourcePath, original)

    await savePdfWithSourceGuard({
      sourcePath,
      targetPath: sourcePath,
      recoveryPath,
      diskState,
      editedBytes: await applySaveRequest(original, request(sourcePath)),
      hooks: {
        afterJournalBeforeClaim: async () => {
          const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
            sourcePath: string
            claimPath: string
          }
          expect(journal.sourcePath).toBe(sourcePath)
          expect(journal.claimPath).toContain('.genoffice-claim-')
          expect(hash(await readFile(sourcePath))).toBe(hash(original))
        },
      },
    })
  })

  it('fails closed when retained source-safety history reaches its directory cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'genoffice-pdf-guard-budget-'))
    cleanups.push(directory)
    const sourcePath = join(directory, 'source.pdf')
    const original = await makePdf(200)
    await writeFile(sourcePath, original)
    const diskState = await capturePdfDiskState(sourcePath, original)
    await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        writeFile(`${sourcePath}.genoffice-claim-old-${index}`, new Uint8Array([index])),
      ),
    )

    await expect(
      savePdfWithSourceGuard({
        sourcePath,
        targetPath: sourcePath,
        recoveryPath: join(directory, 'recovery.pdf'),
        diskState,
        editedBytes: await applySaveRequest(original, request(sourcePath)),
      }),
    ).rejects.toThrow('source safety history is full')
    expect(hash(await readFile(sourcePath))).toBe(hash(original))
  })

  it('serializes the directory claim reservation across concurrent PDF saves', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'genoffice-pdf-guard-concurrent-'))
    cleanups.push(directory)
    const firstPath = join(directory, 'first.pdf')
    const secondPath = join(directory, 'second.pdf')
    const original = await makePdf(200)
    await Promise.all([writeFile(firstPath, original), writeFile(secondPath, original)])
    await Promise.all(
      Array.from({ length: 31 }, (_, index) =>
        writeFile(join(directory, `old.pdf.genoffice-claim-${index}`), new Uint8Array([index])),
      ),
    )
    const [firstState, secondState] = await Promise.all([
      capturePdfDiskState(firstPath, original),
      capturePdfDiskState(secondPath, original),
    ])

    const results = await Promise.allSettled([
      savePdfWithSourceGuard({
        sourcePath: firstPath,
        targetPath: firstPath,
        recoveryPath: join(directory, 'first-recovery.pdf'),
        diskState: firstState,
        editedBytes: await applySaveRequest(original, request(firstPath)),
      }),
      savePdfWithSourceGuard({
        sourcePath: secondPath,
        targetPath: secondPath,
        recoveryPath: join(directory, 'second-recovery.pdf'),
        diskState: secondState,
        editedBytes: await applySaveRequest(original, request(secondPath)),
      }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(
      (await readdir(directory)).filter((name) => name.includes('.genoffice-claim-')),
    ).toHaveLength(32)
  })

  it.each([
    ['dead-looking', 2_147_483_647],
    ['live-PID', process.pid],
  ])('never reclaims a %s claim-budget lock', async (_label, pid) => {
    const directory = await mkdtemp(join(tmpdir(), 'genoffice-pdf-guard-lock-'))
    cleanups.push(directory)
    const sourcePath = join(directory, 'source.pdf')
    const recoveryPath = join(directory, 'recovery.pdf')
    const lockPath = join(directory, '.genoffice-pdf-claim-budget.lock')
    const original = await makePdf(200)
    const lockBytes = Buffer.from(
      JSON.stringify({ version: 1, pid, token: 'existing-owner', createdAt: 0 }),
    )
    await writeFile(sourcePath, original)
    await writeFile(lockPath, lockBytes, { mode: 0o600 })
    const diskState = await capturePdfDiskState(sourcePath, original)

    await expect(
      savePdfWithSourceGuard({
        sourcePath,
        targetPath: sourcePath,
        recoveryPath,
        diskState,
        editedBytes: await applySaveRequest(original, request(sourcePath)),
        hooks: { claimLockWaitMs: 10 },
      }),
    ).rejects.toThrow('source safety history lock is unavailable')

    expect(hash(await readFile(sourcePath))).toBe(hash(original))
    expect(await readFile(lockPath)).toEqual(lockBytes)
    expect((await readdir(directory)).filter((name) => name.includes('.genoffice-claim-'))).toEqual(
      [],
    )
    await expect(readFile(`${sourcePath}.genoffice-commit.json`)).rejects.toThrow()
  })

  it('does not delete a replacement lock observed while waiting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'genoffice-pdf-guard-lock-'))
    cleanups.push(directory)
    const sourcePath = join(directory, 'source.pdf')
    const lockPath = join(directory, '.genoffice-pdf-claim-budget.lock')
    const original = await makePdf(200)
    const replacementLock = Buffer.from(
      JSON.stringify({ version: 1, pid: process.pid, token: 'replacement-owner', createdAt: 1 }),
    )
    await writeFile(sourcePath, original)
    await writeFile(lockPath, JSON.stringify({ version: 1, pid: -1, token: 'old-owner' }))
    const diskState = await capturePdfDiskState(sourcePath, original)
    let replaced = false

    await expect(
      savePdfWithSourceGuard({
        sourcePath,
        targetPath: sourcePath,
        recoveryPath: join(directory, 'recovery.pdf'),
        diskState,
        editedBytes: await applySaveRequest(original, request(sourcePath)),
        hooks: {
          claimLockWaitMs: 10,
          onClaimLockContended: async () => {
            if (replaced) return
            replaced = true
            await writeFile(lockPath, replacementLock, { mode: 0o600 })
          },
        },
      }),
    ).rejects.toThrow('source safety history lock is unavailable')

    expect(replaced).toBe(true)
    expect(await readFile(lockPath)).toEqual(replacementLock)
    expect(hash(await readFile(sourcePath))).toBe(hash(original))
  })
})
