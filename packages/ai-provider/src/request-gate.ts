import { AI_DEFAULT_TURN_TIMEOUT_MS } from './watchdog'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  withAiRequestLedger,
  type AiRequestAuditEvent,
  type AiRequestAuditReason,
  type AiRequestLedgerEvent,
} from './request-ledger'

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
  const audit: AiRequestAuditEvent[] = []
  const lastDeniedAuditBucket = new Map<AiRequestAuditReason, number>()
  const ledgerPath =
    options.ledgerPath ??
    (options.userDataDir ? join(options.userDataDir, 'ai-request-ledger.json') : undefined)

  const transact = <T>(
    update: (
      current: AiRequestLedgerEvent[],
      currentAudit: AiRequestAuditEvent[],
    ) => { result: T; events?: AiRequestLedgerEvent[]; audit?: AiRequestAuditEvent[] },
  ): T => {
    if (!ledgerPath) {
      const transaction = update(events, audit)
      if (transaction.events) events.splice(0, events.length, ...transaction.events)
      if (transaction.audit) audit.splice(0, audit.length, ...transaction.audit)
      return transaction.result
    }
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

  const auditEvent = (
    at: number,
    tokens: number,
    decision: AiRequestAuditEvent['decision'],
    reason: AiRequestAuditReason,
  ): AiRequestAuditEvent => ({ id: randomUUID(), at, tokens, decision, reason })

  const appendAudit = (
    storedAudit: AiRequestAuditEvent[],
    event: AiRequestAuditEvent,
  ): AiRequestAuditEvent[] | undefined => {
    const retained = storedAudit.filter((entry) => entry.at > event.at - dailyWindowMs)
    if (event.decision === 'deny') {
      const bucket = Math.floor(event.at / 60_000)
      if (lastDeniedAuditBucket.get(event.reason) === bucket) {
        return retained.length === storedAudit.length ? undefined : retained
      }
    }
    return [...retained, event].slice(-10_000)
  }

  const recordDenied = (
    code: Exclude<AiRequestGateError['code'], 'ledger-unavailable'>,
    tokens: number,
    time: number,
  ): never => {
    transact((stored, storedAudit) => {
      const nextAudit = appendAudit(storedAudit, auditEvent(time, tokens, 'deny', code))
      return {
        result: undefined,
        ...(nextAudit === undefined ? {} : { audit: nextAudit }),
      }
    })
    lastDeniedAuditBucket.set(code, Math.floor(time / 60_000))
    throw new AiRequestGateError(code)
  }

  return {
    acquire(requestId: string, tokens: number): AiRequestLease {
      const time = now()
      if (!Number.isSafeInteger(time) || time < 0) {
        throw new AiRequestGateError('ledger-unavailable')
      }
      const auditTokens = Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : 0
      if (isDisabled()) recordDenied('disabled', auditTokens, time)
      if (active.has(requestId)) recordDenied('duplicate', auditTokens, time)
      if (active.size >= maxConcurrent) recordDenied('concurrency', auditTokens, time)
      if (!Number.isSafeInteger(tokens) || tokens < 0) {
        recordDenied('daily-limit', auditTokens, time)
      }
      const reservationId = randomUUID()
      const admission = transact<
        | { readonly allowed: true }
        | { readonly allowed: false; readonly code: 'rate-limit' | 'daily-limit' }
      >((stored, storedAudit) => {
        const retained = stored.filter((entry) => entry.at > time - dailyWindowMs)
        const retainedAudit = storedAudit.filter((entry) => entry.at > time - dailyWindowMs)
        const burst = retained.filter((entry) => entry.at > time - burstWindowMs).length
        const rolling = retained.filter((entry) => entry.at > time - rollingWindowMs).length
        const dailyTokens = retained.reduce((sum, entry) => sum + entry.tokens, 0)
        const code: 'rate-limit' | 'daily-limit' | undefined =
          burst >= maxBurstRequests || rolling >= maxRollingRequests
            ? 'rate-limit'
            : retained.length >= maxDailyRequests || dailyTokens + tokens > maxDailyTokens
              ? 'daily-limit'
              : undefined
        if (code) {
          const nextAudit = appendAudit(retainedAudit, auditEvent(time, tokens, 'deny', code))
          return {
            result: { allowed: false as const, code },
            ...(retained.length === stored.length ? {} : { events: retained }),
            ...(nextAudit === undefined ? {} : { audit: nextAudit }),
          }
        }
        return {
          result: { allowed: true as const },
          events: [...retained, { id: reservationId, at: time, tokens }],
          audit: appendAudit(retainedAudit, auditEvent(time, tokens, 'allow', 'reserved'))!,
        }
      })
      if (!admission.allowed) {
        lastDeniedAuditBucket.set(admission.code, Math.floor(time / 60_000))
        throw new AiRequestGateError(admission.code)
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
