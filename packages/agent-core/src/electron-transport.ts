import type {
  AgentStreamErrorCode,
  AgentStreamRequest,
  AgentToolCall,
  AgentToolDef,
  AgentTransport,
  AgentMessage,
} from './types'

/**
 * One streamed chunk pushed back over an Electron IPC bridge. Structurally
 * identical to ai-provider's AiStreamChunk; declared here so this package
 * stays dependency-free.
 */
export interface IpcStreamChunk {
  requestId: string
  /** 'ping' = wire-level keepalive; re-arms the silence watchdog and carries no payload */
  type: 'delta' | 'tool-call' | 'done' | 'error' | 'ping'
  text?: string
  toolCall?: AgentToolCall
  error?: string
  /** machine-readable error cause; maps to a localized safe message */
  errorCode?: AgentStreamErrorCode
  /** normalized stop reason on 'done' ('max_tokens' = cut off by the token limit) */
  stopReason?: string
}

/** The request forwarded to the main process to start one streaming turn. */
export interface IpcStreamStart<S> {
  requestId: string
  job: IpcJobBudgetTicket
  settings: S
  system: string
  messages: AgentMessage[]
  tools: AgentToolDef[]
  maxTokens: number
}

export interface IpcJobBudgetTicket {
  jobId: string
  capability: string
  maximumOutputTokens: number
}

/**
 * Renderer-side silence watchdog: the main process re-arms it with keepalive
 * pings on wire activity, so firing means the turn is dead (main-process stall,
 * lost chunks) and the run must fail instead of leaving the UI busy forever.
 * Longer than the main-process idle timeout so that one (localized) wins.
 */
export const IPC_STREAM_SILENCE_TIMEOUT_MS = 90_000

export interface IpcTransportOptions<S> {
  /** subscribe to stream chunks; returns the unsubscribe function */
  onStream(listener: (chunk: IpcStreamChunk) => void): () => void
  /** forward the start request to the main process; a returned promise reports handler failure */
  start(request: IpcStreamStart<S>): void | Promise<unknown>
  /** abort the in-flight turn in the main process */
  cancel(requestId: string): void
  getSettings(): S
  /** Current main-issued ticket, reused by every provider turn in one UI job. */
  getJobTicket(): IpcJobBudgetTicket | null
  /** Requested output reservation per turn; main clamps it to the job remainder. */
  maxTokensPerTurn?: number
  /** Optional per-request override for models that legitimately reason silently longer. */
  silenceTimeoutMs?(settings: S): number
  /** localized fallback when an error chunk carries no message */
  unknownErrorText(): string
  /** localized message for timeouts (errorCode 'timeout' and the silence watchdog) */
  timeoutErrorText?(): string
  /** localized message for exhausted credits (errorCode 'credits') */
  creditsErrorText?(): string
  /** localized message for the server-enforced job ceiling (errorCode 'budget') */
  budgetErrorText?(): string
}

/**
 * AgentTransport over an Electron IPC bridge: the main process talks to the
 * LLM providers (avoids renderer CORS) and streams chunks back per requestId.
 * Each app wires in its own preload bridge and i18n via the options.
 */
export function createIpcTransport<S>(options: IpcTransportOptions<S>): AgentTransport {
  const timeoutText = () => options.timeoutErrorText?.() ?? options.unknownErrorText()
  return {
    stream(request: AgentStreamRequest, cb) {
      const requestId = crypto.randomUUID()
      const settings = options.getSettings()
      const job = options.getJobTicket()
      const silenceTimeoutMs = options.silenceTimeoutMs?.(settings) ?? IPC_STREAM_SILENCE_TIMEOUT_MS
      let settled = false
      let silenceTimer: ReturnType<typeof setTimeout> | undefined
      const settle = () => {
        settled = true
        clearTimeout(silenceTimer)
        unsubscribe()
      }
      const fail = (error: string) => {
        if (settled) return
        settle()
        cb.onError(error)
      }
      const armSilence = () => {
        clearTimeout(silenceTimer)
        silenceTimer = setTimeout(() => {
          options.cancel(requestId)
          fail(timeoutText())
        }, silenceTimeoutMs)
      }
      const unsubscribe = options.onStream((chunk) => {
        if (chunk.requestId !== requestId || settled) return
        if (chunk.type === 'ping') {
          armSilence()
        } else if (chunk.type === 'delta') {
          armSilence()
          cb.onDelta(chunk.text ?? '')
        } else if (chunk.type === 'tool-call') {
          armSilence()
          if (chunk.toolCall) cb.onToolCall(chunk.toolCall)
        } else if (chunk.type === 'done') {
          settle()
          if (chunk.stopReason) cb.onStopReason?.(chunk.stopReason)
          cb.onDone()
        } else {
          settle()
          const code = chunk.errorCode
          const message =
            chunk.errorCode === 'timeout'
              ? timeoutText()
              : chunk.errorCode === 'credits'
                ? (options.creditsErrorText?.() ?? chunk.error ?? options.unknownErrorText())
                : chunk.errorCode === 'budget'
                  ? (options.budgetErrorText?.() ?? chunk.error ?? options.unknownErrorText())
                  : (chunk.error ?? options.unknownErrorText())
          if (code) cb.onError(message, code)
          else cb.onError(message)
        }
      })
      armSilence()
      try {
        // a rejected/thrown start would otherwise leave the run pending until the watchdog
        Promise.resolve(
          options.start({
            requestId,
            job: job ?? {
              jobId: 'missing',
              capability: 'missing',
              maximumOutputTokens: 8_192,
            },
            settings,
            system: request.system,
            messages: request.messages,
            tools: request.tools,
            maxTokens: options.maxTokensPerTurn ?? 2_048,
          }),
        ).catch((err: unknown) => {
          fail(err instanceof Error ? err.message : options.unknownErrorText())
        })
      } catch (err) {
        fail(err instanceof Error ? err.message : options.unknownErrorText())
      }
      return { cancel: () => options.cancel(requestId) }
    },
  }
}
