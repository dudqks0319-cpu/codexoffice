import { describe, expect, it, vi } from 'vitest'
import { inspectPptxDesignIsolated } from '../src/main/design-inspect-client'

function silentWorker() {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  return {
    once(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, listener)
      return this
    },
    postMessage: vi.fn(),
    terminate: vi.fn(() => Promise.resolve(0)),
  }
}

describe('isolated PPTX design inspection', () => {
  it('hard-terminates a worker that exceeds the whole-operation deadline', async () => {
    const worker = silentWorker()
    await expect(
      inspectPptxDesignIsolated(new Uint8Array([1]), 'source.pptx', 5, () => worker as never),
    ).rejects.toThrow(/timed out/)
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
})
