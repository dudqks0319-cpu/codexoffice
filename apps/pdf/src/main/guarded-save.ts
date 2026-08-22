import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'

import { atomicWrite } from './atomic-write'
import { replacePdfIfUnchanged } from './conditional-write'
import type { PdfDiskState } from './pdf-file-state'
import { capturePdfDiskState, sha256Bytes } from './pdf-file-state'
import { prunePrivateArtifacts } from './private-artifacts'

export type GuardedPdfSaveResult =
  | { readonly kind: 'saved' }
  | {
      readonly kind: 'source-changed'
      readonly recoveryPath: string
      readonly preservedPath?: string
    }

/**
 * Persist bytes produced from the immutable session snapshot. In-place writes
 * claim and verify the live directory entry before replacement; a conflict
 * produces a complete private recovery PDF. Save As never reads or mutates the
 * live source.
 */
export async function savePdfWithSourceGuard(args: {
  readonly sourcePath: string
  readonly targetPath: string
  readonly recoveryPath: string
  readonly diskState: PdfDiskState
  readonly editedBytes: Uint8Array
  readonly hooks?: {
    readonly beforeClaim?: () => Promise<void>
    readonly afterJournalBeforeClaim?: () => Promise<void>
    readonly afterInstall?: () => Promise<void>
    readonly claimLockWaitMs?: number
    readonly onClaimLockContended?: () => Promise<void>
  }
}): Promise<GuardedPdfSaveResult> {
  if (args.targetPath !== args.sourcePath) {
    await atomicWrite(args.targetPath, args.editedBytes)
    return { kind: 'saved' }
  }
  const replaced = await replacePdfIfUnchanged({
    sourcePath: args.sourcePath,
    expectedState: args.diskState,
    replacementBytes: args.editedBytes,
    hooks: args.hooks,
  })
  if (replaced.kind === 'changed') {
    await prunePrivateArtifacts(dirname(args.recoveryPath), {
      keepPaths: [args.recoveryPath],
      maxFiles: 32,
      maxBytes: 512 * 1024 * 1024,
      maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
      reserveBytes: args.editedBytes.byteLength,
    })
    await atomicWrite(args.recoveryPath, args.editedBytes, { private: true })
    let preservedPath = replaced.preservedPath
    if (preservedPath?.endsWith('.edited')) {
      const displaced = await capturePdfDiskState(preservedPath).catch(() => null)
      if (displaced?.sha256 === sha256Bytes(args.editedBytes)) {
        await rm(preservedPath, { force: true })
        preservedPath = undefined
      }
    }
    return {
      kind: 'source-changed',
      recoveryPath: args.recoveryPath,
      ...(preservedPath ? { preservedPath } : {}),
    }
  }
  return { kind: 'saved' }
}
