import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AgentMessage, AgentToolCall } from '@genoffice/agent-core'
import type { AiJobBudgetTicket, AiStreamRequest } from './types'

export const AI_JOB_MAX_OUTPUT_TOKENS = 8_192
export const AI_JOB_MAX_INPUT_TOKENS = 131_072
export const AI_JOB_MAX_PROVIDER_TURNS = 16
export const AI_TURN_MAX_OUTPUT_TOKENS = 2_048

const JOB_RETENTION_MS = 24 * 60 * 60_000
const IMAGE_INPUT_TOKEN_ALLOWANCE = 4_096

interface JobRecord {
  owner: string
  ticket: AiJobBudgetTicket
  inputTokens: number
  outputTokens: number
  turns: number
  activeRequests: Set<string>
  ended: boolean
  touchedAt: number
}

export class AiJobBudgetError extends Error {
  readonly code: 'invalid-ticket' | 'duplicate' | 'budget' | 'turn-limit'

  constructor(code: AiJobBudgetError['code']) {
    super('AI job budget unavailable')
    this.name = 'AiJobBudgetError'
    this.code = code
  }
}

export interface AiJobTurnLease {
  readonly maxTokens: number
  settle(result: { providerStarted: boolean; completed: boolean; outputTokens?: number }): void
}

export interface AiJobBudgetGateOptions {
  now?: () => number
  capability?: () => string
  maximumOutputTokens?: number
  maximumInputTokens?: number
  maximumProviderTurns?: number
  maximumTurnOutputTokens?: number
}

function sameCapability(actual: string, expected: string): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

function safeTokenCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new AiJobBudgetError('budget')
  return value
}

/** Sender-bound, main-issued budget tickets and cumulative turn accounting. */
export function createAiJobBudgetGate(options: AiJobBudgetGateOptions = {}) {
  const now = options.now ?? Date.now
  const newCapability = options.capability ?? (() => randomBytes(32).toString('base64url'))
  const maximumOutputTokens = options.maximumOutputTokens ?? AI_JOB_MAX_OUTPUT_TOKENS
  const maximumInputTokens = options.maximumInputTokens ?? AI_JOB_MAX_INPUT_TOKENS
  const maximumProviderTurns = options.maximumProviderTurns ?? AI_JOB_MAX_PROVIDER_TURNS
  const maximumTurnOutputTokens = options.maximumTurnOutputTokens ?? AI_TURN_MAX_OUTPUT_TOKENS
  const jobs = new Map<string, JobRecord>()
  const currentJobByOwner = new Map<string, string>()

  const prune = () => {
    const cutoff = now() - JOB_RETENTION_MS
    for (const [jobId, job] of jobs) {
      if (job.activeRequests.size === 0 && job.touchedAt <= cutoff) jobs.delete(jobId)
    }
  }

  const find = (owner: string, ticket: AiJobBudgetTicket): JobRecord => {
    const job = jobs.get(ticket.jobId)
    if (
      !job ||
      job.owner !== owner ||
      job.ended ||
      ticket.maximumOutputTokens !== maximumOutputTokens ||
      !sameCapability(ticket.capability, job.ticket.capability)
    ) {
      throw new AiJobBudgetError('invalid-ticket')
    }
    return job
  }

  return {
    begin(owner: string, jobId: string): AiJobBudgetTicket {
      prune()
      for (const job of jobs.values()) {
        if (job.owner === owner && job.activeRequests.size > 0) {
          throw new AiJobBudgetError('duplicate')
        }
      }
      const existing = jobs.get(jobId)
      if (existing) {
        if (existing.owner !== owner || existing.ended) throw new AiJobBudgetError('invalid-ticket')
        existing.touchedAt = now()
        return existing.ticket
      }
      const previousId = currentJobByOwner.get(owner)
      const previous = previousId ? jobs.get(previousId) : undefined
      if (previous) {
        if (previous.activeRequests.size > 0) throw new AiJobBudgetError('duplicate')
        previous.ended = true
        jobs.delete(previous.ticket.jobId)
      }
      const ticket = Object.freeze({
        jobId,
        capability: newCapability(),
        maximumOutputTokens,
      })
      const job: JobRecord = {
        owner,
        ticket,
        inputTokens: 0,
        outputTokens: 0,
        turns: 0,
        activeRequests: new Set(),
        ended: false,
        touchedAt: now(),
      }
      jobs.set(jobId, job)
      currentJobByOwner.set(owner, jobId)
      return ticket
    },

    acquireTurn(
      owner: string,
      ticket: AiJobBudgetTicket,
      requestId: string,
      inputTokens: number,
      requestedOutputTokens: number,
    ): AiJobTurnLease {
      const job = find(owner, ticket)
      const input = safeTokenCount(inputTokens)
      const requested = safeTokenCount(requestedOutputTokens)
      if (requested < 1) throw new AiJobBudgetError('budget')
      if (job.activeRequests.has(requestId)) throw new AiJobBudgetError('duplicate')
      if (job.activeRequests.size > 0) throw new AiJobBudgetError('duplicate')
      if (job.turns >= maximumProviderTurns) throw new AiJobBudgetError('turn-limit')
      if (job.inputTokens + input > maximumInputTokens) throw new AiJobBudgetError('budget')
      const remaining = maximumOutputTokens - job.outputTokens
      const maxTokens = Math.min(requested, maximumTurnOutputTokens, remaining)
      if (maxTokens < 1) throw new AiJobBudgetError('budget')

      job.inputTokens += input
      job.turns += 1
      job.activeRequests.add(requestId)
      job.touchedAt = now()
      let settled = false
      return {
        maxTokens,
        settle(result) {
          if (settled) return
          settled = true
          job.activeRequests.delete(requestId)
          job.touchedAt = now()
          if (!result.providerStarted) {
            job.inputTokens -= input
            job.turns -= 1
            return
          }
          const observedOutputTokens = result.completed
            ? safeTokenCount(result.outputTokens ?? 0)
            : maxTokens
          job.outputTokens += observedOutputTokens
          if (observedOutputTokens > maxTokens) {
            job.ended = true
            if (currentJobByOwner.get(owner) === ticket.jobId) currentJobByOwner.delete(owner)
          }
          if (job.ended && job.activeRequests.size === 0) jobs.delete(job.ticket.jobId)
        },
      }
    },

    end(owner: string, ticket: AiJobBudgetTicket): void {
      const job = find(owner, ticket)
      job.ended = true
      job.touchedAt = now()
      if (currentJobByOwner.get(owner) === ticket.jobId) currentJobByOwner.delete(owner)
      if (job.activeRequests.size === 0) jobs.delete(ticket.jobId)
    },

    clearOwner(owner: string): void {
      for (const job of jobs.values()) {
        if (job.owner !== owner) continue
        job.ended = true
        if (job.activeRequests.size === 0) jobs.delete(job.ticket.jobId)
      }
      currentJobByOwner.delete(owner)
    },
  }
}

function utf8Tokens(value: string): number {
  return Math.ceil(new TextEncoder().encode(value).byteLength / 4)
}

function jsonTokens(value: unknown): number {
  try {
    return utf8Tokens(JSON.stringify(value))
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

function messageInputTokens(message: AgentMessage): number {
  if (message.role === 'user') {
    return utf8Tokens(message.text) + (message.images?.length ?? 0) * IMAGE_INPUT_TOKEN_ALLOWANCE
  }
  if (message.role === 'assistant') {
    return utf8Tokens(message.text) + jsonTokens(message.toolCalls ?? [])
  }
  return jsonTokens(message.results)
}

/** Conservative, content-only estimate; image binary is charged a fixed high allowance per image. */
export function estimateAiStreamInputTokens(
  request: Pick<AiStreamRequest, 'system' | 'messages' | 'tools'>,
): number {
  const messages = request.messages.reduce((sum, message) => sum + messageInputTokens(message), 0)
  return safeTokenCount(utf8Tokens(request.system) + messages + jsonTokens(request.tools ?? []))
}

export function estimateAiStreamOutputTokens(
  text: string,
  toolCalls: readonly AgentToolCall[],
): number {
  return safeTokenCount(utf8Tokens(text) + jsonTokens(toolCalls))
}

export const globalAiJobBudgetGate = createAiJobBudgetGate()
