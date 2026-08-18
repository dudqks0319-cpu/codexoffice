import { AI_DEFAULT_TURN_TIMEOUT_MS } from './watchdog'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { withAiRequestLedger, type AiRequestLedgerEvent } from './request-ledger'

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
  /** Persist usage beneath this Electron userData directory. */
  userDataDir?: string
  /** Explicit ledger file, primarily for hosts/tests that already own a storage path. */
  ledgerPath?: string
  ledgerLockTimeoutMs?: number
  ledgerStaleLockMs?: number
}

export interface AiRequestLease {
  release(): void
  /** Remove a reservation only when paid work was never started. Idempotent. */
  rollback(): void
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
  readonly code:
    'disabled' | 'duplicate' | 'concurrency' | 'rate-limit' | 'daily-limit' | 'ledger-unavailable'

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
  const events: AiRequestLedgerEvent[] = []
  const ledgerPath =
    options.ledgerPath ??
    (options.userDataDir ? join(options.userDataDir, 'ai-request-ledger.json') : undefined)

  const transact = <T>(
    update: (current: AiRequestLedgerEvent[]) => { result: T; events?: AiRequestLedgerEvent[] },
  ): T => {
    if (!ledgerPath) return update(events).result
    try {
      return withAiRequestLedger(
        {
          path: ledgerPath,
          ...(options.ledgerLockTimeoutMs === undefined
            ? {}
            : { lockTimeoutMs: options.ledgerLockTimeoutMs }),
          ...(options.ledgerStaleLockMs === undefined
            ? {}
            : { staleLockMs: options.ledgerStaleLockMs }),
        },
        update,
      )
    } catch (error) {
      if (error instanceof AiRequestGateError) throw error
      throw new AiRequestGateError('ledger-unavailable')
    }
  }

  return {
    acquire(requestId: string, tokens: number): AiRequestLease {
      if (isDisabled()) throw new AiRequestGateError('disabled')
      if (active.has(requestId)) throw new AiRequestGateError('duplicate')
      if (active.size >= maxConcurrent) throw new AiRequestGateError('concurrency')
      const time = now()
      if (!Number.isSafeInteger(tokens) || tokens < 0) throw new AiRequestGateError('daily-limit')
      const reservationId = randomUUID()
      if (ledgerPath) {
        transact((stored) => {
          const retained = stored.filter((entry) => entry.at > time - dailyWindowMs)
          const burst = retained.filter((entry) => entry.at > time - burstWindowMs).length
          const rolling = retained.filter((entry) => entry.at > time - rollingWindowMs).length
          if (burst >= maxBurstRequests || rolling >= maxRollingRequests)
            throw new AiRequestGateError('rate-limit')
          const dailyTokens = retained.reduce((sum, entry) => sum + entry.tokens, 0)
          if (retained.length >= maxDailyRequests || dailyTokens + tokens > maxDailyTokens)
            throw new AiRequestGateError('daily-limit')
          return {
            result: undefined,
            events: [...retained, { id: reservationId, at: time, tokens }],
          }
        })
      } else {
        while (events[0] && events[0].at <= time - dailyWindowMs) events.shift()
        const burst = events.filter((entry) => entry.at > time - burstWindowMs).length
        const rolling = events.filter((entry) => entry.at > time - rollingWindowMs).length
        if (burst >= maxBurstRequests || rolling >= maxRollingRequests)
          throw new AiRequestGateError('rate-limit')
        const dailyTokens = events.reduce((sum, entry) => sum + entry.tokens, 0)
        if (events.length >= maxDailyRequests || dailyTokens + tokens > maxDailyTokens)
          throw new AiRequestGateError('daily-limit')
        events.push({ id: reservationId, at: time, tokens })
      }
      active.add(requestId)
      let released = false
      let rolledBack = false
      return {
        release() {
          if (released) return
          released = true
          active.delete(requestId)
        },
        rollback() {
          if (released || rolledBack) return
          rolledBack = true
          active.delete(requestId)
          released = true
          if (ledgerPath) {
            transact((stored) => ({
              result: undefined,
              events: stored.filter((entry) => entry.id !== reservationId),
            }))
          } else {
            const index = events.findIndex((entry) => entry.id === reservationId)
            if (index >= 0) events.splice(index, 1)
          }
        },
      }
    },
  }
}

const initialLedgerPath = process.env.GENOFFICE_AI_LEDGER_PATH
let globalAiRequestGate = createAiRequestGate(
  initialLedgerPath === undefined ? {} : { ledgerPath: initialLedgerPath },
)
let globalGateUsed = false

/** Configure the process-global gate from Electron app.getPath('userData'), before its first use. */
export function configureAiRequestGateStorage(userDataDir: string): void {
  if (globalGateUsed) throw new Error('AI request gate storage must be configured before use')
  globalAiRequestGate = createAiRequestGate({ userDataDir })
}

export function acquireAiRequest(requestId: string, tokens: number): AiRequestLease {
  globalGateUsed = true
  return globalAiRequestGate.acquire(requestId, tokens)
}
