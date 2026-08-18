import { afterEach, describe, expect, it, vi } from 'vitest'

import { startPdfJobMemoryWatchdog } from '../src/main/pdf-job-memory'

afterEach(() => {
  vi.useRealTimers()
})

describe('PDF job memory watchdog', () => {
  it('fails immediately when the sandbox already exceeds the ceiling', () => {
    const onExceeded = vi.fn()
    const stop = startPdfJobMemoryWatchdog({
      limitKiB: 512,
      pollMs: 25,
      maxUnavailableSamples: 4,
      readWorkingSetKiB: () => 513,
      onExceeded,
      onUnavailable: vi.fn(),
    })
    expect(onExceeded).toHaveBeenCalledOnce()
    expect(onExceeded).toHaveBeenCalledWith(513)
    stop()
  })

  it('detects a later allocation and reports it only once', () => {
    vi.useFakeTimers()
    let observed = 128
    const onExceeded = vi.fn()
    const stop = startPdfJobMemoryWatchdog({
      limitKiB: 512,
      pollMs: 25,
      maxUnavailableSamples: 4,
      readWorkingSetKiB: () => observed,
      onExceeded,
      onUnavailable: vi.fn(),
    })
    observed = 700
    vi.advanceTimersByTime(100)
    expect(onExceeded).toHaveBeenCalledOnce()
    stop()
  })

  it('stops sampling after cleanup', () => {
    vi.useFakeTimers()
    let observed = 128
    const onExceeded = vi.fn()
    const stop = startPdfJobMemoryWatchdog({
      limitKiB: 512,
      pollMs: 25,
      maxUnavailableSamples: 4,
      readWorkingSetKiB: () => observed,
      onExceeded,
      onUnavailable: vi.fn(),
    })
    stop()
    observed = 700
    vi.advanceTimersByTime(100)
    expect(onExceeded).not.toHaveBeenCalled()
  })

  it('rejects invalid limits instead of silently disabling enforcement', () => {
    expect(() =>
      startPdfJobMemoryWatchdog({
        limitKiB: 0,
        pollMs: 25,
        maxUnavailableSamples: 4,
        readWorkingSetKiB: () => 0,
        onExceeded: vi.fn(),
        onUnavailable: vi.fn(),
      }),
    ).toThrow(/invalid isolated job memory limit/)
  })

  it('fails closed when trusted process metrics remain unavailable', () => {
    vi.useFakeTimers()
    const onExceeded = vi.fn()
    const onUnavailable = vi.fn()
    const stop = startPdfJobMemoryWatchdog({
      limitKiB: 512,
      pollMs: 25,
      maxUnavailableSamples: 4,
      readWorkingSetKiB: () => undefined,
      onExceeded,
      onUnavailable,
    })
    vi.advanceTimersByTime(100)
    expect(onExceeded).not.toHaveBeenCalled()
    expect(onUnavailable).toHaveBeenCalledOnce()
    stop()
  })
})
