import { readFile, rename, rm, writeFile } from 'node:fs/promises'

import type { SavePdfRequest } from '../shared/ipc'
import { applySaveRequest } from './pdf-transform'

export { applySaveRequest, extractPagesBytes, insertPdfBytes } from './pdf-transform'

/**
 * Node-only compatibility wrapper used by focused unit tests. Production PDF
 * handlers run the transform in a sandboxed job renderer and only write the
 * validated result from Electron main.
 */
export async function savePdfToPath(
  sourcePath: string,
  targetPath: string,
  request: SavePdfRequest,
): Promise<void> {
  const bytes = await applySaveRequest(new Uint8Array(await readFile(sourcePath)), request)
  const tmp = `${targetPath}.gensave-${process.pid}.tmp`
  try {
    await writeFile(tmp, bytes)
    await rename(tmp, targetPath)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}
