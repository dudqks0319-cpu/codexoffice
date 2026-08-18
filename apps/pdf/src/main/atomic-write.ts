import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface AtomicWriteOptions {
  /** Local recovery/session artifacts contain document data and must be owner-only. */
  readonly private?: boolean
  /** Owner-only file in a user-owned directory whose directory mode must not change. */
  readonly privateFileOnly?: boolean
}

async function targetMode(filePath: string, isPrivate: boolean): Promise<number> {
  if (isPrivate) return 0o600
  try {
    return (await stat(filePath)).mode & 0o777
  } catch {
    return 0o666
  }
}

export async function prepareAtomicWrite(
  filePath: string,
  bytes: Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<string> {
  await mkdir(dirname(filePath), { recursive: true, mode: options.private ? 0o700 : 0o777 })
  if (options.private) await chmod(dirname(filePath), 0o700)
  const tmp = `${filePath}.${process.pid}-${randomUUID()}.tmp`
  const handle = await open(
    tmp,
    'wx',
    await targetMode(filePath, options.private === true || options.privateFileOnly === true),
  )
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(tmp, { force: true })
    throw error
  }
  await handle.close()
  return tmp
}

export async function syncParent(filePath: string): Promise<void> {
  const handle = await open(dirname(filePath), 'r').catch(() => null)
  if (!handle) return
  try {
    await handle.sync()
  } catch {
    // Directory fsync is not supported by every target filesystem.
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Write beside the destination and rename, so interruption never leaves a partial file. */
export async function atomicWrite(
  filePath: string,
  bytes: Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const tmp = await prepareAtomicWrite(filePath, bytes, options)
  try {
    await rename(tmp, filePath)
    if (options.private || options.privateFileOnly) await chmod(filePath, 0o600)
    await syncParent(filePath)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}
