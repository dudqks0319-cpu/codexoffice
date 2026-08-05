import { chmod, lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { codexChildEnvironment, resolveCodexExecutable } from './codex-executable'
import {
  CodexAppServerClient,
  type CodexAppServerClientLike,
  type CodexAppServerNotification,
} from './codex-app-server'

export const CODEX_IMAGE_MAX_PROMPT_BYTES = 8 * 1024
export const CODEX_IMAGE_MAX_BYTES = 8 * 1024 * 1024
export const CODEX_IMAGE_MAX_DIMENSION = 4096
export const CODEX_IMAGE_DEFAULT_TIMEOUT_MS = 180_000

const REPLAY_TTL_MS = 24 * 60 * 60_000
const BURST_WINDOW_MS = 60_000
const ROLLING_WINDOW_MS = 60 * 60_000
const DAILY_WINDOW_MS = 24 * 60 * 60_000
const ALLOWED_ITEM_TYPES = new Set(['userMessage', 'agentMessage', 'reasoning', 'imageGeneration'])
const IMAGE_INSTRUCTIONS = [
  'This is an isolated one-shot image generation thread for Codexoffice.',
  'Use only the built-in image generation capability and create exactly one original image.',
  'Never run commands, inspect files, browse, use web search, MCP, apps, plugins, skills, hooks, or delegate work.',
  'Do not request approval or attempt to expand the read-only sandbox.',
].join(' ')

const DISABLED_FEATURES = [
  'apps',
  'auth_elicitation',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'code_mode',
  'code_mode_host',
  'computer_use',
  'chronicle',
  'goals',
  'hooks',
  'in_app_browser',
  'in_app_updates',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'plugins',
  'plugin_sharing',
  'remote_plugin',
  'shell_snapshot',
  'shell_tool',
  'skill_mcp_dependency_install',
  'skill_search',
  'tool_suggest',
  'unified_exec',
  'workspace_dependencies',
] as const

export type CodexImageErrorCode =
  | 'IMAGE_DISABLED'
  | 'IMAGE_CONFIRMATION_REQUIRED'
  | 'IMAGE_INPUT_INVALID'
  | 'IMAGE_DUPLICATE'
  | 'IMAGE_QUOTA_EXCEEDED'
  | 'IMAGE_BUSY'
  | 'IMAGE_SIGN_IN_REQUIRED'
  | 'IMAGE_UNAVAILABLE'
  | 'IMAGE_PROTOCOL_INVALID'
  | 'IMAGE_OUTPUT_INVALID'
  | 'IMAGE_TIMEOUT'
  | 'IMAGE_CANCELLED'
  | 'IMAGE_PROVIDER_FAILED'

export class CodexImageError extends Error {
  readonly code: CodexImageErrorCode

  constructor(code: CodexImageErrorCode) {
    super(publicErrorMessage(code))
    this.name = 'CodexImageError'
    this.code = code
  }
}

function publicErrorMessage(code: CodexImageErrorCode): string {
  switch (code) {
    case 'IMAGE_DISABLED':
      return 'Codex image generation is disabled'
    case 'IMAGE_CONFIRMATION_REQUIRED':
      return 'Codex image generation requires explicit user confirmation'
    case 'IMAGE_INPUT_INVALID':
      return 'The image request is invalid'
    case 'IMAGE_DUPLICATE':
      return 'This image request was already submitted'
    case 'IMAGE_QUOTA_EXCEEDED':
      return 'The image generation quota was exceeded'
    case 'IMAGE_BUSY':
      return 'Codex image generation is already busy'
    case 'IMAGE_SIGN_IN_REQUIRED':
      return 'Codex image generation requires ChatGPT sign-in'
    case 'IMAGE_UNAVAILABLE':
      return 'Codex image generation is unavailable for this account'
    case 'IMAGE_TIMEOUT':
      return 'Codex image generation timed out'
    case 'IMAGE_CANCELLED':
      return 'Codex image generation was cancelled'
    case 'IMAGE_OUTPUT_INVALID':
      return 'Codex returned an invalid image'
    case 'IMAGE_PROTOCOL_INVALID':
      return 'Codex returned an invalid image protocol response'
    default:
      return 'Codex image generation failed'
  }
}

export interface CodexImageRequest {
  requestId: string
  /** Opaque authenticated-user or privacy-preserving session/IP fingerprint. Never pass a raw IP. */
  subjectId: string
  prompt: string
  userConfirmed: boolean
}

export interface CodexImageResult {
  requestId: string
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  bytes: Buffer
  base64: string
  width: number
  height: number
}

interface FileStatLike {
  mode: number
  size: number
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

export interface CodexImageFileSystem {
  makeTempDirectory(prefix: string): Promise<string>
  chmod(filePath: string, mode: number): Promise<void>
  lstat(filePath: string): Promise<FileStatLike>
  realpath(filePath: string): Promise<string>
  remove(filePath: string): Promise<void>
}

export interface CodexImageClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}

export interface CodexImageQuotaOptions {
  maxConcurrent?: number
  maxConcurrentPerSubject?: number
  burst?: number
  rolling?: number
  daily?: number
  globalBurst?: number
  globalRolling?: number
  globalDaily?: number
}

export interface CodexImageGeneratorOptions {
  isEnabled?: () => boolean
  timeoutMs?: number
  quota?: CodexImageQuotaOptions
  resolveExecutable?: () => string
  createClient?: (options: {
    executable: string
    args: readonly string[]
    cwd: string
    env: Record<string, string>
  }) => CodexAppServerClientLike
  fileSystem?: CodexImageFileSystem
  clock?: CodexImageClock
}

interface ActiveTurn {
  controller: AbortController
  client?: CodexAppServerClientLike
  threadId?: string
  turnId?: string
}

interface CompletionContext {
  threadId: string
  turnId?: string
  image?: Promise<CodexImageResult>
  imageCount: number
  settled: boolean
  resolve(): void
  reject(error: CodexImageError): void
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function defaultFileSystem(): CodexImageFileSystem {
  return {
    makeTempDirectory: (prefix) => mkdtemp(prefix),
    chmod,
    lstat,
    realpath,
    remove: (filePath) => rm(filePath, { recursive: true, force: true }),
  }
}

function defaultClock(): CodexImageClock {
  return { now: Date.now, setTimeout, clearTimeout }
}

export function codexImageAppServerArgs(): readonly string[] {
  const args = [
    'app-server',
    '--strict-config',
    '--listen',
    'stdio://',
    '-c',
    'forced_login_method="chatgpt"',
    '-c',
    'cli_auth_credentials_store="file"',
    '-c',
    'check_for_update_on_startup=false',
    '-c',
    'web_search="disabled"',
    '-c',
    'tools.web_search=false',
    '-c',
    'file_opener="none"',
    '-c',
    'feedback.enabled=false',
    '-c',
    'analytics.enabled=false',
    '-c',
    'history.persistence="none"',
    '-c',
    'shell_environment_policy.inherit="none"',
    '-c',
    'mcp_servers={}',
    '-c',
    'plugins={}',
    '-c',
    'hooks={}',
    '--enable',
    'image_generation',
  ]
  for (const feature of DISABLED_FEATURES) args.push('--disable', feature)
  return args
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)
  )
}

function validateRequest(request: CodexImageRequest): string {
  if (
    !record(request) ||
    !validIdentifier(request.requestId) ||
    !validIdentifier(request.subjectId) ||
    typeof request.prompt !== 'string' ||
    request.prompt.includes('\0') ||
    request.prompt.trim().length === 0 ||
    Buffer.byteLength(request.prompt, 'utf8') > CODEX_IMAGE_MAX_PROMPT_BYTES
  ) {
    throw new CodexImageError('IMAGE_INPUT_INVALID')
  }
  return request.prompt.trim()
}

function decodeBase64(value: unknown): Buffer {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > Math.ceil((CODEX_IMAGE_MAX_BYTES * 4) / 3) + 4 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new CodexImageError('IMAGE_OUTPUT_INVALID')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > CODEX_IMAGE_MAX_BYTES || bytes.toString('base64') !== value) {
    throw new CodexImageError('IMAGE_OUTPUT_INVALID')
  }
  return bytes
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  const magic = Buffer.from('89504e470d0a1a0a', 'hex')
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(magic)) return undefined
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return undefined
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
    return undefined
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) return undefined
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) return undefined
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    if (isSof) {
      if (length < 7) return undefined
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) }
    }
    offset += length
  }
  return undefined
}

function webpDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (
    bytes.length < 30 ||
    bytes.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    bytes.subarray(8, 12).toString('ascii') !== 'WEBP'
  )
    return undefined
  const kind = bytes.subarray(12, 16).toString('ascii')
  if (kind === 'VP8X') {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    }
  }
  if (kind === 'VP8L') {
    if (bytes[20] !== 0x2f) return undefined
    const bits = bytes.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (kind === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    }
  }
  return undefined
}

function validateImage(bytes: Buffer): Omit<CodexImageResult, 'requestId' | 'bytes' | 'base64'> {
  if (bytes.length === 0 || bytes.length > CODEX_IMAGE_MAX_BYTES) {
    throw new CodexImageError('IMAGE_OUTPUT_INVALID')
  }
  const png = pngDimensions(bytes)
  const jpeg = png ? undefined : jpegDimensions(bytes)
  const webp = png || jpeg ? undefined : webpDimensions(bytes)
  const dimensions = png ?? jpeg ?? webp
  if (
    !dimensions ||
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    dimensions.width > CODEX_IMAGE_MAX_DIMENSION ||
    dimensions.height > CODEX_IMAGE_MAX_DIMENSION
  ) {
    throw new CodexImageError('IMAGE_OUTPUT_INVALID')
  }
  return {
    mime: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp',
    ...dimensions,
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  )
}

function safeThreadResponse(
  value: unknown,
  directory: string,
): value is {
  thread: { id: string; cwd: string; ephemeral: true }
  approvalPolicy: 'never'
  sandbox: { type: 'readOnly'; networkAccess: false }
  cwd: string
  instructionSources: unknown[]
} {
  if (!record(value) || !record(value.thread) || !record(value.sandbox)) return false
  return (
    validIdentifier(value.thread.id) &&
    value.thread.ephemeral === true &&
    value.approvalPolicy === 'never' &&
    value.sandbox.type === 'readOnly' &&
    value.sandbox.networkAccess === false &&
    value.cwd === directory &&
    value.thread.cwd === directory &&
    Array.isArray(value.instructionSources) &&
    value.instructionSources.length === 0
  )
}

export class CodexImageGenerator {
  readonly #isEnabled: () => boolean
  readonly #timeoutMs: number
  readonly #quota: Required<CodexImageQuotaOptions>
  readonly #resolveExecutable: () => string
  readonly #createClient: NonNullable<CodexImageGeneratorOptions['createClient']>
  readonly #fs: CodexImageFileSystem
  readonly #clock: CodexImageClock
  readonly #replays = new Map<string, number>()
  readonly #usage = new Map<string, number[]>()
  #globalUsage: number[] = []
  readonly #active = new Map<string, ActiveTurn>()
  readonly #activeSubjects = new Map<string, number>()

  constructor(options: CodexImageGeneratorOptions = {}) {
    this.#isEnabled =
      options.isEnabled ?? (() => process.env.GENOFFICE_CODEX_IMAGE_GENERATION === '1')
    this.#timeoutMs = options.timeoutMs ?? CODEX_IMAGE_DEFAULT_TIMEOUT_MS
    this.#quota = {
      maxConcurrent: options.quota?.maxConcurrent ?? 1,
      maxConcurrentPerSubject: options.quota?.maxConcurrentPerSubject ?? 1,
      burst: options.quota?.burst ?? 2,
      rolling: options.quota?.rolling ?? 10,
      daily: options.quota?.daily ?? 20,
      globalBurst: options.quota?.globalBurst ?? 10,
      globalRolling: options.quota?.globalRolling ?? 60,
      globalDaily: options.quota?.globalDaily ?? 200,
    }
    this.#resolveExecutable = options.resolveExecutable ?? resolveCodexExecutable
    this.#createClient =
      options.createClient ?? ((clientOptions) => new CodexAppServerClient(clientOptions))
    this.#fs = options.fileSystem ?? defaultFileSystem()
    this.#clock = options.clock ?? defaultClock()
  }

  async generate(request: CodexImageRequest, signal?: AbortSignal): Promise<CodexImageResult> {
    if (signal?.aborted) throw new CodexImageError('IMAGE_CANCELLED')
    if (!this.#isEnabled()) throw new CodexImageError('IMAGE_DISABLED')
    if (request?.userConfirmed !== true) throw new CodexImageError('IMAGE_CONFIRMATION_REQUIRED')
    const prompt = validateRequest(request)
    const now = this.#clock.now()
    this.#prune(now)
    if (this.#replays.has(request.requestId)) throw new CodexImageError('IMAGE_DUPLICATE')
    this.#enforceQuota(request.subjectId, now)
    this.#replays.set(request.requestId, now)
    this.#usage.set(request.subjectId, [...(this.#usage.get(request.subjectId) ?? []), now])
    this.#globalUsage.push(now)
    const controller = new AbortController()
    const active: ActiveTurn = { controller }
    this.#active.set(request.requestId, active)
    this.#activeSubjects.set(
      request.subjectId,
      (this.#activeSubjects.get(request.subjectId) ?? 0) + 1,
    )
    const cancel = () => controller.abort(new CodexImageError('IMAGE_CANCELLED'))
    signal?.addEventListener('abort', cancel, { once: true })
    const timer = this.#clock.setTimeout(
      () => controller.abort(new CodexImageError('IMAGE_TIMEOUT')),
      this.#timeoutMs,
    )
    let directory: string | undefined
    let completed = false
    let generatedResult: CodexImageResult | undefined
    let cleanupFailed = false
    try {
      directory = await this.#fs.makeTempDirectory(path.join(os.tmpdir(), 'genoffice-codex-image-'))
      await this.#fs.chmod(directory, 0o700)
      const directoryStat = await this.#fs.lstat(directory)
      if (
        !directoryStat.isDirectory() ||
        directoryStat.isSymbolicLink() ||
        (process.platform !== 'win32' && (directoryStat.mode & 0o077) !== 0)
      ) {
        throw new CodexImageError('IMAGE_PROTOCOL_INVALID')
      }
      const client = this.#createClient({
        executable: this.#resolveExecutable(),
        args: codexImageAppServerArgs(),
        cwd: directory,
        env: { ...codexChildEnvironment(), TMPDIR: directory, TEMP: directory, TMP: directory },
      })
      active.client = client
      await this.#abortable(client.start(), controller.signal)
      const account = await this.#abortable(
        client.request('account/read', { refreshToken: false }),
        controller.signal,
      )
      if (!record(account) || !record(account.account) || account.account.type !== 'chatgpt') {
        throw new CodexImageError('IMAGE_SIGN_IN_REQUIRED')
      }
      const capabilities = await this.#abortable(
        client.request('modelProvider/capabilities/read', {}),
        controller.signal,
      )
      if (!record(capabilities) || capabilities.imageGeneration !== true) {
        throw new CodexImageError('IMAGE_UNAVAILABLE')
      }
      const thread = await this.#abortable(
        client.request('thread/start', {
          cwd: directory,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          baseInstructions: IMAGE_INSTRUCTIONS,
          developerInstructions: IMAGE_INSTRUCTIONS,
          ephemeral: true,
        }),
        controller.signal,
      )
      if (!safeThreadResponse(thread, directory)) {
        throw new CodexImageError('IMAGE_PROTOCOL_INVALID')
      }
      active.threadId = thread.thread.id
      const completion = this.#completion(client, request.requestId, directory, active)
      const started = await this.#abortable(
        client.request('turn/start', {
          threadId: active.threadId,
          input: [
            {
              type: 'text',
              text: `Generate exactly one original image. User request: ${prompt}`,
              text_elements: [],
            },
          ],
          cwd: directory,
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          summary: 'none',
        }),
        controller.signal,
      )
      if (!record(started) || !record(started.turn) || !validIdentifier(started.turn.id)) {
        throw new CodexImageError('IMAGE_PROTOCOL_INVALID')
      }
      if (active.turnId && active.turnId !== started.turn.id) {
        throw new CodexImageError('IMAGE_PROTOCOL_INVALID')
      }
      active.turnId = started.turn.id
      const result = await this.#abortable(completion, controller.signal)
      completed = true
      generatedResult = result
    } catch (error) {
      if (error instanceof CodexImageError) throw error
      if (controller.signal.reason instanceof CodexImageError) throw controller.signal.reason
      throw new CodexImageError('IMAGE_PROVIDER_FAILED')
    } finally {
      this.#clock.clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if (!completed && active.client && active.threadId && active.turnId) {
        await active.client
          .request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId })
          .catch(() => undefined)
      }
      await active.client?.stop().catch(() => {
        cleanupFailed = true
      })
      if (directory) {
        await this.#fs.remove(directory).catch(() => {
          cleanupFailed = true
        })
      }
      this.#active.delete(request.requestId)
      const subjectActive = (this.#activeSubjects.get(request.subjectId) ?? 1) - 1
      if (subjectActive > 0) this.#activeSubjects.set(request.subjectId, subjectActive)
      else this.#activeSubjects.delete(request.subjectId)
      if (cleanupFailed) {
        process.emitWarning('Codex image process or temporary-directory cleanup failed', {
          code: 'CODEX_IMAGE_CLEANUP_FAILED',
        })
      }
    }
    if (cleanupFailed) throw new CodexImageError('IMAGE_PROTOCOL_INVALID')
    if (!generatedResult) throw new CodexImageError('IMAGE_PROVIDER_FAILED')
    return generatedResult
  }

  cancel(requestId: string): boolean {
    const active = this.#active.get(requestId)
    if (!active) return false
    active.controller.abort(new CodexImageError('IMAGE_CANCELLED'))
    if (active.client && active.threadId && active.turnId) {
      void active.client
        .request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId })
        .catch(() => undefined)
    }
    return true
  }

  #prune(now: number): void {
    for (const [requestId, timestamp] of this.#replays) {
      if (timestamp <= now - REPLAY_TTL_MS) this.#replays.delete(requestId)
    }
    for (const [subjectId, timestamps] of this.#usage) {
      const retained = timestamps.filter((timestamp) => timestamp > now - DAILY_WINDOW_MS)
      if (retained.length) this.#usage.set(subjectId, retained)
      else this.#usage.delete(subjectId)
    }
    this.#globalUsage = this.#globalUsage.filter((timestamp) => timestamp > now - DAILY_WINDOW_MS)
  }

  #enforceQuota(subjectId: string, now: number): void {
    if (this.#active.size >= this.#quota.maxConcurrent) throw new CodexImageError('IMAGE_BUSY')
    if ((this.#activeSubjects.get(subjectId) ?? 0) >= this.#quota.maxConcurrentPerSubject) {
      throw new CodexImageError('IMAGE_BUSY')
    }
    const usage = this.#usage.get(subjectId) ?? []
    const globalUsage = this.#globalUsage
    if (
      usage.filter((timestamp) => timestamp > now - BURST_WINDOW_MS).length >= this.#quota.burst ||
      usage.filter((timestamp) => timestamp > now - ROLLING_WINDOW_MS).length >=
        this.#quota.rolling ||
      usage.length >= this.#quota.daily ||
      globalUsage.filter((timestamp) => timestamp > now - BURST_WINDOW_MS).length >=
        this.#quota.globalBurst ||
      globalUsage.filter((timestamp) => timestamp > now - ROLLING_WINDOW_MS).length >=
        this.#quota.globalRolling ||
      globalUsage.length >= this.#quota.globalDaily
    ) {
      throw new CodexImageError('IMAGE_QUOTA_EXCEEDED')
    }
  }

  async #abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw signal.reason
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    ])
  }

  #completion(
    client: CodexAppServerClientLike,
    requestId: string,
    directory: string,
    active: ActiveTurn,
  ): Promise<CodexImageResult> {
    return new Promise((resolve, reject) => {
      const context: CompletionContext = {
        threadId: active.threadId!,
        imageCount: 0,
        settled: false,
        resolve: () => undefined,
        reject: () => undefined,
      }
      const dispose = client.onNotification((notification) =>
        this.#handleNotification(notification, context, requestId, directory),
      )
      context.resolve = () => {
        if (context.settled) return
        context.settled = true
        dispose()
        void context.image?.then(resolve, reject)
      }
      context.reject = (error) => {
        if (context.settled) return
        context.settled = true
        dispose()
        reject(error)
      }
    })
  }

  #handleNotification(
    notification: CodexAppServerNotification,
    context: CompletionContext,
    requestId: string,
    directory: string,
  ): void {
    if (!record(notification.params) || notification.params.threadId !== context.threadId) return
    const params = notification.params
    if (notification.method === 'turn/started') {
      if (!record(params.turn) || !validIdentifier(params.turn.id)) {
        return context.reject(new CodexImageError('IMAGE_PROTOCOL_INVALID'))
      }
      if (context.turnId && context.turnId !== params.turn.id) {
        return context.reject(new CodexImageError('IMAGE_PROTOCOL_INVALID'))
      }
      context.turnId = params.turn.id
      return
    }
    if (typeof params.turnId === 'string' && context.turnId && params.turnId !== context.turnId)
      return
    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      if (!record(params.item) || !ALLOWED_ITEM_TYPES.has(String(params.item.type))) {
        return context.reject(new CodexImageError('IMAGE_PROTOCOL_INVALID'))
      }
      if (notification.method === 'item/completed' && params.item.type === 'imageGeneration') {
        context.imageCount++
        if (context.imageCount !== 1) {
          return context.reject(new CodexImageError('IMAGE_OUTPUT_INVALID'))
        }
        context.image = this.#readImageItem(params.item, requestId, directory)
        void context.image.catch((error) =>
          context.reject(
            error instanceof CodexImageError ? error : new CodexImageError('IMAGE_OUTPUT_INVALID'),
          ),
        )
      }
      return
    }
    if (notification.method === 'turn/completed') {
      if (!record(params.turn) || (context.turnId && params.turn.id !== context.turnId)) return
      if (params.turn.status !== 'completed' || context.imageCount !== 1 || !context.image) {
        return context.reject(
          new CodexImageError(
            params.turn.status === 'interrupted' ? 'IMAGE_CANCELLED' : 'IMAGE_OUTPUT_INVALID',
          ),
        )
      }
      context.resolve()
      return
    }
    if (notification.method === 'error') {
      context.reject(new CodexImageError('IMAGE_PROVIDER_FAILED'))
    }
  }

  async #readImageItem(
    item: Record<string, unknown>,
    requestId: string,
    directory: string,
  ): Promise<CodexImageResult> {
    if (
      !validIdentifier(item.id) ||
      item.status !== 'completed' ||
      typeof item.result !== 'string' ||
      !(
        item.savedPath === null ||
        item.savedPath === undefined ||
        typeof item.savedPath === 'string'
      )
    ) {
      throw new CodexImageError('IMAGE_OUTPUT_INVALID')
    }
    const resultBytes = decodeBase64(item.result)
    if (typeof item.savedPath === 'string') {
      if (!path.isAbsolute(item.savedPath)) throw new CodexImageError('IMAGE_PROTOCOL_INVALID')
      const root = await this.#fs.realpath(directory)
      const candidate = await this.#fs.realpath(item.savedPath).catch(() => {
        throw new CodexImageError('IMAGE_PROTOCOL_INVALID')
      })
      if (!isPathInside(root, candidate)) throw new CodexImageError('IMAGE_PROTOCOL_INVALID')
      const stat = await this.#fs.lstat(candidate)
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size <= 0 ||
        stat.size > CODEX_IMAGE_MAX_BYTES ||
        stat.size !== resultBytes.length
      ) {
        throw new CodexImageError('IMAGE_OUTPUT_INVALID')
      }
    }
    // The bounded, validated protocol result is authoritative. The optional saved path is
    // confinement-checked only; never reopen it after validation, avoiding path-swap races
    // and unbounded reads if another process changes the file.
    const metadata = validateImage(resultBytes)
    return {
      requestId,
      bytes: resultBytes,
      base64: resultBytes.toString('base64'),
      ...metadata,
    }
  }
}
