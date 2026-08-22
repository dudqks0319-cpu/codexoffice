import { realpathSync } from 'node:fs'

/**
 * Main-process allowlist for local attachment paths. Paths are canonicalized
 * when a trusted picker/drop flow grants them, then re-resolved before every
 * read so a replaced symlink cannot redirect access to another file.
 */
export class AttachmentPathGrants {
  readonly #pathsByOwner = new Map<number, Set<string>>()

  grant(ownerId: number, paths: readonly string[]): string[] {
    const granted = this.#pathsByOwner.get(ownerId) ?? new Set<string>()
    const canonicalPaths: string[] = []
    for (const path of paths) {
      try {
        const canonicalPath = realpathSync.native(path)
        granted.add(canonicalPath)
        canonicalPaths.push(canonicalPath)
      } catch {
        // The file may disappear between validation and grant. Skip it rather
        // than failing the whole multi-file selection.
      }
    }
    this.#pathsByOwner.set(ownerId, granted)
    return canonicalPaths
  }

  resolve(ownerId: number, path: string): string | null {
    const granted = this.#pathsByOwner.get(ownerId)
    // Check the exact renderer-visible path before touching the filesystem so
    // arbitrary paths cannot be used as an existence oracle.
    if (!granted?.has(path)) return null
    try {
      return realpathSync.native(path) === path ? path : null
    } catch {
      return null
    }
  }

  clear(ownerId: number): void {
    this.#pathsByOwner.delete(ownerId)
  }
}
