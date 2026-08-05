import { describe, expect, it, vi } from 'vitest'
import {
  AiRequestGateError,
  createAiRequestGate,
  createAiTurnController,
  runIfAiTurnActive,
} from '../src/request-gate'

describe('AI request gate', () => {
  it('rejects duplicate active IDs and releases idempotently', () => {
    const gate = createAiRequestGate({ isDisabled: () => false })
    const lease = gate.acquire('same', 10)
    expect(() => gate.acquire('same', 10)).toThrowError(
      expect.objectContaining<Partial<AiRequestGateError>>({ code: 'duplicate' }),
    )
    lease.release()
    lease.release()
    expect(() => gate.acquire('same', 10)).not.toThrow()
  })

  it('enforces concurrency independent of request ID rotation', () => {
    const gate = createAiRequestGate({ isDisabled: () => false, maxConcurrent: 1 })
    const lease = gate.acquire('a', 1)
    expect(() => gate.acquire('b', 1)).toThrowError(
      expect.objectContaining<Partial<AiRequestGateError>>({ code: 'concurrency' }),
    )
    lease.release()
  })

  it('enforces burst and daily token budgets at their boundaries', () => {
    let time = 1_000
    const burst = createAiRequestGate({
      now: () => time,
      isDisabled: () => false,
      maxBurstRequests: 2,
      maxRollingRequests: 10,
      maxDailyRequests: 10,
    })
    burst.acquire('a', 1).release()
    burst.acquire('b', 1).release()
    expect(() => burst.acquire('c', 1)).toThrowError(
      expect.objectContaining<Partial<AiRequestGateError>>({ code: 'rate-limit' }),
    )
    time += 60_001
    expect(() => burst.acquire('c', 1)).not.toThrow()

    const daily = createAiRequestGate({
      isDisabled: () => false,
      maxDailyTokens: 10,
      maxDailyRequests: 10,
      maxBurstRequests: 10,
      maxRollingRequests: 10,
    })
    daily.acquire('x', 10).release()
    expect(() => daily.acquire('y', 1)).toThrowError(
      expect.objectContaining<Partial<AiRequestGateError>>({ code: 'daily-limit' }),
    )
  })

  it('fails closed when the server-side kill switch is active', () => {
    const gate = createAiRequestGate({ isDisabled: () => true })
    expect(() => gate.acquire('a', 1)).toThrowError(
      expect.objectContaining<Partial<AiRequestGateError>>({ code: 'disabled' }),
    )
  })

  it('aborts a continuously active turn at the absolute deadline and cleans up the timer', () => {
    vi.useFakeTimers()
    const deadline = createAiTurnController(100)
    vi.advanceTimersByTime(99)
    expect(deadline.controller.signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(deadline.controller.signal.aborted).toBe(true)
    expect(deadline.timedOut).toBe(true)
    deadline.release()
    vi.useRealTimers()
  })

  it('does not start paid work when the sender disappears during an async preflight', async () => {
    const controller = new AbortController()
    let finishPreflight!: () => void
    const preflight = new Promise<void>((resolve) => {
      finishPreflight = resolve
    })
    const paidWork = vi.fn(async () => undefined)
    const flow = (async () => {
      await preflight
      return runIfAiTurnActive(controller.signal, () => true, paidWork)
    })()
    controller.abort()
    finishPreflight()
    await expect(flow).resolves.toBe(false)
    expect(paidWork).not.toHaveBeenCalled()
  })
})
