import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
} from 'node:fs'
import { chmod, link, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import type { PdfDiskState } from './pdf-file-state'
import { capturePdfDiskState, pdfSourceChanged, sha256Bytes } from './pdf-file-state'
import { prepareAtomicWrite, syncParent } from './atomic-write'

export type ConditionalWriteResult =
  { readonly kind: 'replaced' } | { readonly kind: 'changed'; readonly preservedPath?: string }

interface ConditionalWriteHooks {
  /** Unit-test seam for the exact check-to-claim race. */
  readonly beforeClaim?: () => Promise<void>
  /** Unit-test seam proving the repair journal is durable while source still exists. */
  readonly afterJournalBeforeClaim?: () => Promise<void>
  /** Unit-test seam for a second writer replacing the installed edit. */
  readonly afterInstall?: () => Promise<void>
  /** Unit-test-only deadline override for the directory budget lock. */
  readonly claimLockWaitMs?: number
  /** Unit-test seam reached after an existing directory budget lock is observed. */
  readonly onClaimLockContended?: () => Promise<void>
}

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined

interface PdfCommitJournal {
  readonly version: 1
  readonly pid: number
  readonly sourcePath: string
  readonly claimPath: string
}

const journalPathFor = (sourcePath: string): string => `${sourcePath}.genoffice-commit.json`
const claimPrefixFor = (sourcePath: string): string => `${basename(sourcePath)}.genoffice-claim-`
const MAX_CLAIM_FILES_PER_DIRECTORY = 32
const MAX_CLAIM_BYTES_PER_DIRECTORY = 512 * 1024 * 1024
const CLAIM_LOCK_WAIT_MS = 5_000

const syncParentSync = (sourcePath: string): void => {
  let descriptor: number | undefined
  try {
    descriptor = openSync(dirname(sourcePath), 'r')
    fsyncSync(descriptor)
  } catch {
    // Directory fsync is not available on every filesystem.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

/**
 * Repair the only source-missing crash window before a PDF path is granted.
 * An exclusive hard link refuses to overwrite a path recreated by another app.
 */
function repairInterruptedPdfCommitPathSync(sourcePath: string, seen: Set<string>): boolean {
  if (seen.has(sourcePath)) return false
  seen.add(sourcePath)
  try {
    if (lstatSync(sourcePath).isSymbolicLink()) {
      return repairInterruptedPdfCommitPathSync(
        resolve(dirname(sourcePath), readlinkSync(sourcePath)),
        seen,
      )
    }
  } catch {
    // A missing regular path may be the interrupted target repaired below.
  }
  const journalPath = journalPathFor(sourcePath)
  if (existsSync(sourcePath)) {
    try {
      const raw = JSON.parse(readFileSync(journalPath, 'utf8')) as Partial<PdfCommitJournal>
      if (typeof raw.pid === 'number' && processIsAlive(raw.pid)) return false
      unlinkSync(journalPath)
      syncParentSync(sourcePath)
    } catch {
      // No stale journal exists, or it cannot be removed safely.
    }
    return false
  }
  let journal: PdfCommitJournal
  try {
    const raw = JSON.parse(readFileSync(journalPath, 'utf8')) as Partial<PdfCommitJournal>
    if (
      raw.version !== 1 ||
      typeof raw.pid !== 'number' ||
      raw.sourcePath !== sourcePath ||
      typeof raw.claimPath !== 'string' ||
      dirname(raw.claimPath) !== dirname(sourcePath) ||
      !basename(raw.claimPath).startsWith(claimPrefixFor(sourcePath))
    ) {
      return false
    }
    journal = raw as PdfCommitJournal
  } catch {
    return false
  }
  if (processIsAlive(journal.pid)) return false
  try {
    linkSync(journal.claimPath, sourcePath)
    unlinkSync(journalPath)
    syncParentSync(sourcePath)
    return true
  } catch {
    return false
  }
}

export function repairInterruptedPdfCommitSync(sourcePath: string): boolean {
  return repairInterruptedPdfCommitPathSync(sourcePath, new Set())
}

const processIsAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) !== 'ESRCH'
  }
}

async function acquireClaimDirectoryLock(
  sourcePath: string,
  waitMs = CLAIM_LOCK_WAIT_MS,
  onContended?: () => Promise<void>,
): Promise<{
  readonly path: string
  readonly token: string
}> {
  const lockPath = join(dirname(sourcePath), '.genoffice-pdf-claim-budget.lock')
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const token = randomUUID()
    const prepared = await prepareAtomicWrite(
      lockPath,
      Buffer.from(JSON.stringify({ version: 1, pid: process.pid, token, createdAt: Date.now() })),
      { privateFileOnly: true },
    )
    try {
      await link(prepared, lockPath)
      await rm(prepared, { force: true })
      await syncParent(lockPath)
      return { path: lockPath, token }
    } catch (error) {
      await rm(prepared, { force: true })
      if (errorCode(error) !== 'EEXIST') throw error
      // Never reclaim this shared pathname from a waiter. A PID liveness check
      // cannot distinguish PID reuse and a check-then-unlink can delete a newer
      // owner's lock (ABA). A crashed lock therefore blocks in-place save until
      // every GenOffice instance is closed and the exact lock is removed.
      await onContended?.()
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw new Error(
    `pdf: source safety history lock is unavailable at ${lockPath}; close every GenOffice instance before removing that exact lock, or use Save As`,
  )
}

async function releaseClaimDirectoryLock(lock: {
  readonly path: string
  readonly token: string
}): Promise<void> {
  try {
    const raw = JSON.parse(readFileSync(lock.path, 'utf8')) as { token?: unknown }
    if (raw.token !== lock.token) return
    await rm(lock.path, { force: true })
    await syncParent(lock.path)
  } catch {
    // A crashed or externally removed lock needs no further cleanup here.
  }
}

async function createCommitJournal(journalPath: string, journal: PdfCommitJournal): Promise<void> {
  const prepared = await prepareAtomicWrite(journalPath, Buffer.from(JSON.stringify(journal)), {
    privateFileOnly: true,
  })
  try {
    await link(prepared, journalPath)
    await rm(prepared, { force: true })
    await syncParent(journalPath)
  } catch (error) {
    await rm(prepared, { force: true })
    throw error
  }
}

async function assertClaimBudget(sourcePath: string, reserveBytes: number): Promise<void> {
  const entries = await readdir(dirname(sourcePath), { withFileTypes: true })
  const claims = entries.filter(
    (entry) => entry.isFile() && entry.name.includes('.genoffice-claim-'),
  )
  let bytes = 0
  for (const entry of claims) {
    bytes += (await stat(join(dirname(sourcePath), entry.name)).catch(() => ({ size: 0 }))).size
  }
  if (
    claims.length >= MAX_CLAIM_FILES_PER_DIRECTORY ||
    bytes + reserveBytes > MAX_CLAIM_BYTES_PER_DIRECTORY
  ) {
    throw new Error(
      `pdf: source safety history is full in ${dirname(sourcePath)}; preserve or remove old .genoffice-claim files before saving again`,
    )
  }
}

/**
 * Claim the current directory entry before replacing it. The displaced file is
 * retained until its hash is verified, so a writer racing the pre-check is
 * restored instead of being silently overwritten.
 */
interface ReplacePdfIfUnchangedArgs {
  readonly sourcePath: string
  readonly expectedState: PdfDiskState
  readonly replacementBytes: Uint8Array
  readonly hooks?: ConditionalWriteHooks
}

async function replacePdfIfUnchangedLocked(
  args: ReplacePdfIfUnchangedArgs,
): Promise<ConditionalWriteResult> {
  if (await pdfSourceChanged(args.expectedState, args.sourcePath)) return { kind: 'changed' }
  await assertClaimBudget(args.sourcePath, args.expectedState.size)
  const prepared = await prepareAtomicWrite(args.sourcePath, args.replacementBytes)
  const replacementSha256 = sha256Bytes(args.replacementBytes)
  const claim = `${args.sourcePath}.genoffice-claim-${process.pid}-${randomUUID()}`
  const journal = journalPathFor(args.sourcePath)
  let claimed = false
  let installed = false
  try {
    await args.hooks?.beforeClaim?.()
    repairInterruptedPdfCommitSync(args.sourcePath)
    await createCommitJournal(journal, {
      version: 1,
      pid: process.pid,
      sourcePath: args.sourcePath,
      claimPath: claim,
    })
    await args.hooks?.afterJournalBeforeClaim?.()
    try {
      await rename(args.sourcePath, claim)
      claimed = true
      await chmod(claim, 0o600).catch(() => undefined)
      await syncParent(args.sourcePath)
    } catch {
      await rm(journal, { force: true })
      return { kind: 'changed' }
    }
    try {
      // Hard-linking the already-fsynced temp is an exclusive install: unlike
      // rename, it cannot overwrite a path recreated by another process.
      await link(prepared, args.sourcePath)
      installed = true
      await rm(prepared, { force: true })
      await syncParent(args.sourcePath)
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
      const claimedState = await capturePdfDiskState(claim).catch(() => null)
      if (claimedState?.sha256 === args.expectedState.sha256) {
        await rm(journal, { force: true })
        await syncParent(args.sourcePath)
        return { kind: 'changed' }
      }
      return { kind: 'changed', preservedPath: claim }
    }

    await args.hooks?.afterInstall?.()

    const [claimedState, installedState] = await Promise.all([
      capturePdfDiskState(claim).catch(() => null),
      capturePdfDiskState(args.sourcePath).catch(() => null),
    ])
    if (
      claimedState?.sha256 === args.expectedState.sha256 &&
      installedState?.sha256 === replacementSha256
    ) {
      // Never unlink a displaced inode here. A writer may still hold an open fd
      // and write after our hash; the bounded adjacent artifact preserves it.
      return { kind: 'replaced' }
    }

    if (
      claimedState &&
      claimedState.sha256 !== args.expectedState.sha256 &&
      installedState?.sha256 === replacementSha256
    ) {
      // A first writer won before the claim. Move only our byte-identical edit
      // aside, restore that external version exclusively, and retain the edit
      // until the caller has written its normal private recovery copy.
      const displacedEdit = `${claim}.edited`
      await rename(args.sourcePath, displacedEdit)
      installed = false
      await link(claim, args.sourcePath)
      installed = true
      await rm(journal, { force: true })
      await syncParent(args.sourcePath)
      return { kind: 'changed', preservedPath: displacedEdit }
    }

    if (!installedState) {
      try {
        await link(claim, args.sourcePath)
        installed = true
        await syncParent(args.sourcePath)
      } catch {
        // A concurrently recreated source wins; never overwrite it.
      }
    }
    // A second writer replaced our installed edit. Leave that newest path
    // untouched and retain the displaced prior version for explicit recovery.
    return { kind: 'changed', preservedPath: claim }
  } finally {
    await rm(prepared, { force: true })
    if (claimed && !installed) {
      // Best-effort repair after an unexpected error. Exclusive link refuses to
      // overwrite a path another process recreated.
      try {
        await link(claim, args.sourcePath)
        await rm(journal, { force: true })
        await syncParent(args.sourcePath)
      } catch {
        // The claim remains adjacent for manual recovery rather than being lost.
      }
    }
    if (existsSync(args.sourcePath)) await rm(journal, { force: true })
  }
}

export async function replacePdfIfUnchanged(
  args: ReplacePdfIfUnchangedArgs,
): Promise<ConditionalWriteResult> {
  const lock = await acquireClaimDirectoryLock(
    args.sourcePath,
    args.hooks?.claimLockWaitMs,
    args.hooks?.onClaimLockContended,
  )
  try {
    return await replacePdfIfUnchangedLocked(args)
  } finally {
    await releaseClaimDirectoryLock(lock)
  }
}
