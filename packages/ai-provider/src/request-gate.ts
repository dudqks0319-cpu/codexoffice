import { AI_DEFAULT_TURN_TIMEOUT_MS } from './watchdog'

export interface AiRequestGateOptions {
  now?: () => number
  isDisabled?: () => boolean
  maxConcurrent?: number
  burstWindowMs?: number
  maxBurstRequests?: number
  rollingWindowMs?: number
  maxRollingRequests?: number
  dailyWindowMs?: number
  maxDailyRequests?: number
  maxDailyTokens?: number
}

export interface AiRequestLease {
  release(): void
}

export function createAiTurnController(timeoutMs = AI_DEFAULT_TURN_TIMEOUT_MS): {
  controller: AbortController
  readonly timedOut: boolean
  release(): void
} {
  const controller = new AbortController()
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  return {
    controller,
    get timedOut() {
      return timedOut
    },
    release: () => clearTimeout(deadline),
  }
}

/** Re-check renderer liveness after an async preflight and before paid work starts. */
export async function runIfAiTurnActive(
  signal: AbortSignal,
  isSenderDestroyed: () => boolean,
  run: () => Promise<void>,
): Promise<boolean> {
  if (signal.aborted || isSenderDestroyed()) return false
  await run()
  return true
}

export class AiRequestGateError extends Error {
  readonly code: 'disabled' | 'duplicate' | 'concurrency' | 'rate-limit' | 'daily-limit'

  constructor(code: AiRequestGateError['code']) {
    super('AI request unavailable')
    this.name = 'AiRequestGateError'
    this.code = code
  }
}

export function createAiRequestGate(options: AiRequestGateOptions = {}) {
  const now = options.now ?? Date.now
  const isDisabled = options.isDisabled ?? (() => process.env.GENOFFICE_AI_DISABLED === '1')
  const maxConcurrent = options.maxConcurrent ?? 3
  const burstWindowMs = options.burstWindowMs ?? 60_000
  const maxBurstRequests = options.maxBurstRequests ?? 60
  const rollingWindowMs = options.rollingWindowMs ?? 60 * 60_000
  const maxRollingRequests = options.maxRollingRequests ?? 300
  const dailyWindowMs = options.dailyWindowMs ?? 24 * 60 * 60_000
  const maxDailyRequests = options.maxDailyRequests ?? 1_000
  const maxDailyTokens = options.maxDailyTokens ?? 4_000_000
  const active = new Set<string>()
  const events: Array<{ at: number; tokens: number }> = []

  return {
    acquire(requestId: string, tokens: number): AiRequestLease {
      if (isDisabled()) throw new AiRequestGateError('disabled')
      if (active.has(requestId)) throw new AiRequestGateError('duplicate')
      if (active.size >= maxConcurrent) throw new AiRequestGateError('concurrency')
      const time = now()
      while (events[0] && events[0].at <= time - dailyWindowMs) events.shift()
      const burst = events.filter((entry) => entry.at > time - burstWindowMs).length
      const rolling = events.filter((entry) => entry.at > time - rollingWindowMs).length
      if (burst >= maxBurstRequests || rolling >= maxRollingRequests)
        throw new AiRequestGateError('rate-limit')
      const dailyTokens = events.reduce((sum, entry) => sum + entry.tokens, 0)
      if (events.length >= maxDailyRequests || dailyTokens + tokens > maxDailyTokens)
        throw new AiRequestGateError('daily-limit')
      active.add(requestId)
      events.push({ at: time, tokens })
      let released = false
      return {
        release() {
          if (released) return
          released = true
          active.delete(requestId)
        },
      }
    },
  }
}

const globalAiRequestGate = createAiRequestGate()

export function acquireAiRequest(requestId: string, tokens: number): AiRequestLease {
  return globalAiRequestGate.acquire(requestId, tokens)
}
