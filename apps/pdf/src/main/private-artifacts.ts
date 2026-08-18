import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export interface PrivateArtifactPolicy {
  readonly keepPaths?: readonly string[]
  readonly maxFiles: number
  readonly maxBytes: number
  readonly maxAgeMs: number
  readonly reserveBytes?: number
}

/** Bound owner-only recovery artifacts by age, count, and aggregate bytes. */
export async function prunePrivateArtifacts(
  root: string,
  policy: PrivateArtifactPolicy,
): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  await chmod(root, 0o700)
  const keep = new Set((policy.keepPaths ?? []).map((path) => resolve(path)))
  const now = Date.now()
  const entries = await readdir(root, { withFileTypes: true })
  const files = (
    await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const path = join(root, entry.name)
          await chmod(path, 0o600).catch(() => undefined)
          const info = await stat(path).catch(() => null)
          return info ? { path, size: info.size, mtimeMs: info.mtimeMs } : null
        }),
    )
  )
    .filter((entry): entry is { path: string; size: number; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  let filesKept = keep.size
  let bytesKept = Math.max(0, policy.reserveBytes ?? 0)
  for (const file of files) {
    if (keep.has(resolve(file.path))) continue
    const expired = now - file.mtimeMs > policy.maxAgeMs
    const exceedsCount = filesKept >= Math.max(0, policy.maxFiles)
    const exceedsBytes = bytesKept + file.size > Math.max(0, policy.maxBytes)
    if (expired || exceedsCount || exceedsBytes) {
      await rm(file.path, { force: true })
      continue
    }
    filesKept += 1
    bytesKept += file.size
  }
}
