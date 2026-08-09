import { describe, expect, it, vi } from 'vitest'

import { requireSuccessfulUndo } from '../src/renderer/atomic-undo'

describe('requireSuccessfulUndo', () => {
  it('accepts a confirmed rollback', async () => {
    const undo = vi.fn(async () => true)
    await expect(requireSuccessfulUndo(undo)).resolves.toBeUndefined()
  })

  it('fails closed when Univer resolves false', async () => {
    await expect(requireSuccessfulUndo(async () => false)).rejects.toThrow('Undo returned false.')
  })

  it('propagates a rejected rollback', async () => {
    await expect(
      requireSuccessfulUndo(async () => {
        throw new Error('undo failed')
      }),
    ).rejects.toThrow('undo failed')
  })
})
