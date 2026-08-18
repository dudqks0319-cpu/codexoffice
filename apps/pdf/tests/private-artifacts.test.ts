import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { atomicWrite } from '../src/main/atomic-write'
import { prunePrivateArtifacts } from '../src/main/private-artifacts'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('private PDF artifacts', () => {
  it.skipIf(process.platform === 'win32')('uses owner-only directory and file modes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'genoffice-pdf-private-'))
    cleanups.push(directory)
    const root = join(directory, 'recovery')
    const file = join(root, 'copy.pdf')

    await atomicWrite(file, new Uint8Array([1, 2, 3]), { private: true })

    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('prunes expired and over-quota copies without deleting the active path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-pdf-quota-'))
    cleanups.push(root)
    const active = join(root, 'active.pdf')
    const recent = join(root, 'recent.pdf')
    const old = join(root, 'old.pdf')
    await Promise.all([
      writeFile(active, new Uint8Array(8)),
      writeFile(recent, new Uint8Array(8)),
      writeFile(old, new Uint8Array(8)),
    ])
    const stale = new Date(Date.now() - 10_000)
    await utimes(old, stale, stale)

    await prunePrivateArtifacts(root, {
      keepPaths: [active],
      maxFiles: 1,
      maxBytes: 16,
      maxAgeMs: 1_000,
      reserveBytes: 8,
    })

    await expect(readFile(active)).resolves.toHaveLength(8)
    await expect(readFile(recent)).rejects.toThrow()
    await expect(readFile(old)).rejects.toThrow()
  })
})
