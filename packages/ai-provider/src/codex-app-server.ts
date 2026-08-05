import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'

const REQUEST_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 1_500
const MAX_RPC_LINE_BYTES = 12 * 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024

const ALLOWED_REQUESTS = new Set([
  'initialize',
  'account/read',
  'modelProvider/capabilities/read',
  'thread/start',
  'turn/start',
  'turn/interrupt',
])

const ALLOWED_NOTIFICATIONS = new Set([
  'error',
  'warning',
  'deprecationNotice',
  'configWarning',
  'account/rateLimits/updated',
  'thread/started',
  'thread/status/changed',
  'thread/tokenUsage/updated',
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'rawResponseItem/completed',
  'rawResponse/completed',
  'model/rerouted',
  'model/verification',
  'turn/moderationMetadata',
  'model/safetyBuffering/updated',
  'guardianWarning',
  // Codex 0.146 emits this immediately after initialize even when remote control is disabled.
  // It carries status only and is unrelated to the isolated image turn.
  'remoteControl/status/changed',
])

export interface CodexAppServerNotification {
  method: string
  params?: unknown
}

export interface CodexAppServerClientLike {
  start(): Promise<void>
  request(method: string, params: unknown): Promise<unknown>
  onNotification(listener: (notification: CodexAppServerNotification) => void): () => void
  stop(): Promise<void>
}

interface ProcessLike extends EventEmitter {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  killed: boolean
  kill(signal?: NodeJS.Signals): boolean
}

export interface CodexAppServerClientOptions {
  executable: string
  args: readonly string[]
  cwd: string
  env: Record<string, string>
  requestTimeoutMs?: number
  stopTimeoutMs?: number
  spawnProcess?: (
    executable: string,
    args: readonly string[],
    options: Parameters<typeof spawn>[2],
  ) => ProcessLike
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function protocolError(): Error {
  return new Error('Codex image generation returned an invalid protocol response')
}

export class CodexAppServerClient implements CodexAppServerClientLike {
  readonly #options: CodexAppServerClientOptions
  readonly #events = new EventEmitter()
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  #child: ProcessLike | undefined
  #stdout = Buffer.alloc(0)
  #stderrBytes = 0
  #nextId = 1
  #failed = false
  #expectedStop = false

  constructor(options: CodexAppServerClientOptions) {
    this.#options = options
  }

  async start(): Promise<void> {
    if (this.#child) return
    const spawnProcess =
      this.#options.spawnProcess ??
      ((executable, args, options) =>
        spawn(executable, [...args], options) as ChildProcessWithoutNullStreams)
    const child = spawnProcess(this.#options.executable, this.#options.args, {
      cwd: this.#options.cwd,
      env: this.#options.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.#child = child
    child.stdout.on('data', (chunk: Buffer | string) => this.#handleStdout(chunk))
    child.stderr.on('data', (chunk: Buffer | string) => this.#handleStderr(chunk))
    child.on('close', () => this.#handleClose())
    child.on('error', () => this.#fail())
    await new Promise<void>((resolve, reject) => {
      const spawned = () => {
        child.off('error', failed)
        resolve()
      }
      const failed = () => {
        child.off('spawn', spawned)
        reject(new Error('Codex image generation is unavailable'))
      }
      child.once('spawn', spawned)
      child.once('error', failed)
    })
    await this.request('initialize', {
      clientInfo: { name: 'codexoffice', title: 'Codexoffice', version: '0.1.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    })
    this.#write({ method: 'initialized' })
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (!ALLOWED_REQUESTS.has(method)) return Promise.reject(protocolError())
    if (!this.#child?.stdin.writable || this.#failed) {
      return Promise.reject(new Error('Codex image generation is unavailable'))
    }
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error('Codex image generation timed out'))
      }, this.#options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS)
      timer.unref?.()
      this.#pending.set(id, { resolve, reject, timer })
      try {
        this.#write({ id, method, params })
      } catch {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(protocolError())
      }
    })
  }

  onNotification(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.#events.on('notification', listener)
    return () => this.#events.off('notification', listener)
  }

  async stop(): Promise<void> {
    const child = this.#child
    if (!child) return
    this.#expectedStop = true
    this.#child = undefined
    this.#rejectPending(new Error('Codex image generation stopped'))
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    child.stdin.end()
    if (!child.killed) child.kill('SIGTERM')
    let didClose = false
    const timer = new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, this.#options.stopTimeoutMs ?? STOP_TIMEOUT_MS)
      timeout.unref?.()
    })
    await Promise.race([
      closed.then(() => {
        didClose = true
      }),
      timer,
    ])
    // Node's ChildProcess.killed flips to true as soon as SIGTERM is sent, not when the
    // process actually exits. didClose is the only reliable condition for escalation.
    if (!didClose) {
      child.kill('SIGKILL')
      const forcedTimer = new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, this.#options.stopTimeoutMs ?? STOP_TIMEOUT_MS)
        timeout.unref?.()
      })
      await Promise.race([
        closed.then(() => {
          didClose = true
        }),
        forcedTimer,
      ])
      if (!didClose) throw new Error('Codex image generation process did not stop')
    }
  }

  #write(message: Record<string, unknown>): void {
    const serialized = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(serialized, 'utf8') > MAX_RPC_LINE_BYTES) throw protocolError()
    if (!this.#child?.stdin.writable) throw new Error('Codex image generation is unavailable')
    this.#child.stdin.write(serialized, 'utf8')
  }

  #handleStdout(chunk: Buffer | string): void {
    if (this.#failed) return
    this.#stdout = Buffer.concat([
      this.#stdout,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ])
    if (this.#stdout.length > MAX_RPC_LINE_BYTES && !this.#stdout.includes(0x0a)) {
      this.#fail()
      return
    }
    let newline = this.#stdout.indexOf(0x0a)
    while (newline >= 0) {
      let line = this.#stdout.subarray(0, newline)
      this.#stdout = this.#stdout.subarray(newline + 1)
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1)
      if (line.length > MAX_RPC_LINE_BYTES) return this.#fail()
      if (line.length) this.#handleLine(line.toString('utf8'))
      if (this.#failed) return
      newline = this.#stdout.indexOf(0x0a)
    }
  }

  #handleStderr(chunk: Buffer | string): void {
    this.#stderrBytes += Buffer.byteLength(chunk)
    if (this.#stderrBytes > MAX_STDERR_BYTES) this.#fail()
  }

  #handleLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return this.#fail()
    }
    if (!record(message)) return this.#fail()
    if (Object.hasOwn(message, 'id') && typeof message.method !== 'string') {
      if (typeof message.id !== 'number') return this.#fail()
      const pending = this.#pending.get(message.id)
      if (!pending) return this.#fail()
      clearTimeout(pending.timer)
      this.#pending.delete(message.id)
      if (Object.hasOwn(message, 'error')) pending.reject(new Error('Codex image request failed'))
      else if (Object.hasOwn(message, 'result')) pending.resolve(message.result)
      else this.#fail()
      return
    }
    if (typeof message.method !== 'string' || Object.hasOwn(message, 'id')) return this.#fail()
    if (!ALLOWED_NOTIFICATIONS.has(message.method)) return this.#fail()
    this.#events.emit('notification', { method: message.method, params: message.params })
  }

  #fail(): void {
    if (this.#failed || this.#expectedStop) return
    this.#failed = true
    this.#rejectPending(protocolError())
    void this.stop().catch(() => {
      process.emitWarning('Codex image App Server cleanup failed', {
        code: 'CODEX_IMAGE_PROCESS_CLEANUP_FAILED',
      })
    })
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  #handleClose(): void {
    this.#child = undefined
    if (!this.#expectedStop) this.#fail()
  }
}
