export interface PdfJobMemoryWatchdogOptions {
  readonly limitKiB: number
  readonly pollMs: number
  readonly maxUnavailableSamples: number
  readonly readWorkingSetKiB: () => number | undefined
  readonly onExceeded: (observedKiB: number) => void
  readonly onUnavailable: () => void
}

/**
 * Kill-switch for the one-shot sandbox renderer. Electron exposes renderer
 * working-set metrics from the trusted main process, so no renderer payload is
 * deserialized to enforce this ceiling.
 */
export function startPdfJobMemoryWatchdog(options: PdfJobMemoryWatchdogOptions): () => void {
  if (!Number.isSafeInteger(options.limitKiB) || options.limitKiB <= 0) {
    throw new Error('pdf: invalid isolated job memory limit')
  }
  if (!Number.isSafeInteger(options.pollMs) || options.pollMs <= 0) {
    throw new Error('pdf: invalid isolated job memory polling interval')
  }
  if (!Number.isSafeInteger(options.maxUnavailableSamples) || options.maxUnavailableSamples <= 0) {
    throw new Error('pdf: invalid isolated job memory availability limit')
  }

  let stopped = false
  let exceeded = false
  let unavailableSamples = 0
  const sample = () => {
    if (stopped || exceeded) return
    const observed = options.readWorkingSetKiB()
    if (!Number.isFinite(observed) || (observed as number) < 0) {
      unavailableSamples += 1
      if (unavailableSamples < options.maxUnavailableSamples) return
      exceeded = true
      options.onUnavailable()
      return
    }
    unavailableSamples = 0
    if ((observed as number) <= options.limitKiB) return
    exceeded = true
    options.onExceeded(observed as number)
  }

  sample()
  const timer = setInterval(sample, options.pollMs)
  timer.unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
