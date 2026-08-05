import { describe, expect, it, vi } from 'vitest'

describe('browser-safe package entry', () => {
  it('loads catalogs and settings without evaluating the Codex SDK', async () => {
    vi.doMock('@openai/codex-sdk', () => {
      throw new Error('browser entry evaluated the node-only Codex SDK')
    })
    const entry = await import('../src/index')
    expect(entry.AI_PROVIDERS[0]?.id).toBe('codex')
    expect(entry.defaultAiSettings().provider).toBe('codex')
    expect(entry).not.toHaveProperty('streamForProvider')
    expect(entry).not.toHaveProperty('getCodexAccountStatus')
  })
})
