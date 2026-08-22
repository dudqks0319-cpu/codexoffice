/**
 * AI IPC for the slides main process, extracted from slides-main.ts:
 * settings persistence, the streaming proxy (main process does the networking
 * to avoid renderer CORS), search tools, and slides-only provider-independent tools.
 */
import { app, BrowserWindow, dialog, ipcMain, nativeImage } from 'electron'
import type { IpcMainInvokeEvent, MessageBoxOptions, WebContents } from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import {
  acquireAiRequest,
  AiJobBudgetError,
  AiCreditsError,
  CodexImageError,
  CodexImageGenerator,
  AiTimeoutError,
  CODEX_IMAGE_MAX_BYTES,
  CODEX_IMAGE_MAX_DIMENSION,
  defaultAiSettings,
  createAiTurnController,
  estimateAiStreamInputTokens,
  estimateAiStreamOutputTokens,
  globalAiJobBudgetGate,
  aiTurnTimeoutMsForReasoning,
  getCodexAccountStatus,
  loginCodex,
  parseAiJobBudgetTicket,
  parseAiJobId,
  parseAiRequestId,
  parseAiStreamRequest,
  runIfAiTurnActive,
  streamForProvider,
  type AiSettings,
  type AiStreamChunk,
  type CodexAccountStatus,
  type CodexImageErrorCode,
  type CodexImageResult,
} from '@genoffice/ai-provider/node'
import { fetchBoundedRemoteImage } from '@genoffice/electron-utils'
import { webSearch, imageSearch } from '@genoffice/ai-search'
import { addPicture } from '@genoffice/pptx-engine'
import { EMU_PER_PX_96, type RenderSlide } from '@genoffice/pptx-render'
import { tm } from './i18n-main'
import {
  pushHistory,
  rebuildSlide,
  restoreSnapshot,
  sessions,
  takeSnapshot,
  type Session,
} from './session-state'
import type {
  GenerateSlideImageOp,
  GenerateSlideImageErrorCode,
  GenerateSlideImageResult,
} from '../shared/ipc'
import { getUiLang } from '@genoffice/i18n'

// ---- AI settings + streaming proxy (the main process does the networking to avoid renderer CORS; implementation shared via @genoffice/ai-provider) ----

function readJson<T>(path: string, fallback: T): T {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    /* Corrupted state file: fall back to defaults */
  }
  return fallback
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

const activeAiStreams = new Map<string, AbortController>()
const aiBudgetOwners = new Set<number>()
const codexImages = new CodexImageGenerator()
const CODEX_ACCOUNT_CHECK_ERROR = "Unable to verify this app's Codex account. Try again."

const IMAGE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const IMAGE_SESSION_WATCH_MS = 100
const IMAGE_MIN_FIT_WIDTH_PX = 100
const IMAGE_MAX_EMU = 2_147_483_647
const IMAGE_SUBJECT_ID = 'slides:local-app'

function bindAiBudgetOwner(sender: WebContents): void {
  const senderId = sender.id
  if (aiBudgetOwners.has(senderId)) return
  aiBudgetOwners.add(senderId)
  sender.once('destroyed', () => {
    aiBudgetOwners.delete(senderId)
    globalAiJobBudgetGate.clearOwner(String(senderId))
  })
}

/** Strictly validate the renderer boundary before showing a cost confirmation dialog. */
export function parseGenerateSlideImageOp(input: unknown): GenerateSlideImageOp | null {
  if (!input || typeof input !== 'object') return null
  const op = input as Partial<GenerateSlideImageOp>
  if (
    typeof op.requestId !== 'string' ||
    !IMAGE_REQUEST_ID.test(op.requestId) ||
    typeof op.prompt !== 'string' ||
    !op.prompt.trim() ||
    Buffer.byteLength(op.prompt, 'utf8') > 8_192 ||
    !Number.isInteger(op.slideIndex) ||
    op.slideIndex! < 0 ||
    ![op.xPx, op.yPx, op.wPx, op.hPx, op.fitWidthPx].every(
      (value) => typeof value === 'number' && Number.isFinite(value),
    ) ||
    op.wPx! <= 0 ||
    op.hPx! <= 0 ||
    op.fitWidthPx! < IMAGE_MIN_FIT_WIDTH_PX ||
    op.fitWidthPx! > 10_000 ||
    [op.xPx!, op.yPx!, op.wPx!, op.hPx!].some((value) => Math.abs(value) > 100_000)
  ) {
    return null
  }
  return op as GenerateSlideImageOp
}

type ImageGenerator = Pick<CodexImageGenerator, 'generate'> &
  Partial<Pick<CodexImageGenerator, 'cancel'>>

export interface SlidesImageGenerationDependencies {
  generator: ImageGenerator
  isEnabled(): boolean
  confirm(event: IpcMainInvokeEvent, prompt: string): Promise<boolean>
  getSession(senderId: number): Session | undefined
  insert(
    session: Session,
    op: GenerateSlideImageOp,
    image: CodexImageResult,
  ): { slide: RenderSlide; sourceId: string } | null
}

function imageError(code: GenerateSlideImageErrorCode): string {
  switch (code) {
    case 'IMAGE_CANCELLED':
      return 'Image generation was cancelled.'
    case 'IMAGE_DISABLED':
      return 'Codex image generation is disabled by the local safety switch.'
    case 'IMAGE_DUPLICATE':
      return 'This image request was already submitted.'
    case 'IMAGE_QUOTA_EXCEEDED':
      return 'The image generation quota was reached.'
    case 'IMAGE_BUSY':
      return 'Another image is already being generated. Try again when it finishes.'
    case 'IMAGE_SIGN_IN_REQUIRED':
      return 'Sign in to Codex, then try image generation again.'
    case 'IMAGE_UNAVAILABLE':
      return 'Image generation is unavailable for this Codex account.'
    case 'IMAGE_TIMEOUT':
      return 'Image generation timed out.'
    case 'IMAGE_INSERT_FAILED':
      return 'The generated image could not be inserted into this slide.'
    case 'IMAGE_INPUT_INVALID':
      return 'The image request is invalid.'
    case 'IMAGE_OUTPUT_INVALID':
    case 'IMAGE_PROTOCOL_INVALID':
      return 'Codex returned an invalid image.'
    default:
      return 'Codex image generation failed.'
  }
}

export async function confirmImageGeneration(
  event: IpcMainInvokeEvent,
  prompt: string,
): Promise<boolean> {
  if (shouldAutoConfirmImageGeneration()) return true
  const korean = getUiLang() === 'ko'
  const options: MessageBoxOptions = {
    type: 'question',
    title: korean ? 'Codex 이미지 생성 확인' : 'Confirm Codex image generation',
    message: korean ? 'Codex로 이 이미지를 생성할까요?' : 'Generate this image with Codex?',
    detail: korean
      ? `이 호출은 사용량 또는 비용이 발생할 수 있습니다. 요청: ${prompt}`
      : `This call may consume usage or incur cost. Request: ${prompt}`,
    buttons: korean ? ['이미지 생성', '취소'] : ['Generate image', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
  const parent = BrowserWindow.fromWebContents(event.sender)
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  return result.response === 0
}

/**
 * Automation-only approval for a one-shot packaged smoke run. All three
 * explicit switches and an isolated OS temp userData path are required so a
 * normal packaged launch can never skip the per-call usage/cost dialog.
 */
export function shouldAutoConfirmImageGeneration(env: NodeJS.ProcessEnv = process.env): boolean {
  if (
    env.GENOFFICE_PACKAGED_SMOKE !== '1' ||
    env.GENOFFICE_SMOKE_AUTO_CONFIRM_IMAGE !== '1' ||
    env.GENOFFICE_CODEX_IMAGE_GENERATION !== '1'
  ) {
    return false
  }
  const requestedUserData = env.GENOFFICE_USER_DATA
  if (!requestedUserData) return false
  try {
    const tempRoot = realpathSync(resolve(tmpdir()))
    const isolatedUserData = realpathSync(resolve(requestedUserData))
    return isolatedUserData.startsWith(`${tempRoot}${sep}`)
  } catch {
    return false
  }
}

/** Decode and normalize provider bytes before they cross into the PPTX archive. */
export function normalizeGeneratedImageForInsertion(
  image: CodexImageResult,
): CodexImageResult | null {
  try {
    const decoded = nativeImage.createFromBuffer(image.bytes)
    if (decoded.isEmpty()) return null
    const size = decoded.getSize()
    if (
      !Number.isInteger(size.width) ||
      !Number.isInteger(size.height) ||
      size.width !== image.width ||
      size.height !== image.height ||
      size.width <= 0 ||
      size.height <= 0 ||
      size.width > CODEX_IMAGE_MAX_DIMENSION ||
      size.height > CODEX_IMAGE_MAX_DIMENSION
    ) {
      return null
    }
    const bytes = decoded.toPNG()
    if (!bytes.length || bytes.length > CODEX_IMAGE_MAX_BYTES) return null
    return { ...image, mime: 'image/png', bytes, base64: bytes.toString('base64') }
  } catch {
    return null
  }
}

export function insertGeneratedImage(
  session: Session,
  op: GenerateSlideImageOp,
  image: CodexImageResult,
): { slide: RenderSlide; sourceId: string } | null {
  const slide = session.opened.deck.slides[op.slideIndex]
  if (!slide) return null
  const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
  const scale = session.fitWidthPx / baseWidthPx
  if (!Number.isFinite(baseWidthPx) || baseWidthPx <= 0 || !Number.isFinite(scale) || scale <= 0) {
    return null
  }
  const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
  const x = toEmu(op.xPx)
  const y = toEmu(op.yPx)
  const cx = Math.max(1, toEmu(op.wPx))
  const cy = Math.max(1, toEmu(op.hPx))
  const safeEmu = (value: number) => Number.isSafeInteger(value) && Math.abs(value) <= IMAGE_MAX_EMU
  if (![x, y, cx, cy, x + cx, y + cy].every(safeEmu) || cx <= 0 || cy <= 0) {
    return null
  }
  const before = takeSnapshot(session)
  const undoBefore = [...session.undoStack]
  const redoBefore = [...session.redoStack]
  const htmlPagesBefore = session.htmlPages
  try {
    pushHistory(session)
    const el = addPicture(session.opened, slide, {
      bytes: image.bytes,
      ext: image.mime === 'image/png' ? 'png' : image.mime === 'image/webp' ? 'webp' : 'jpg',
      offset: { x, y, cx, cy },
    })
    if (!el) throw new Error('picture insertion failed')
    const rebuilt = rebuildSlide(session, op.slideIndex)
    if (!rebuilt) throw new Error('slide rebuild failed')
    return { slide: rebuilt, sourceId: el.id }
  } catch {
    restoreSnapshot(session, before)
    session.undoStack = undoBefore
    session.redoStack = redoBefore
    session.htmlPages = htmlPagesBefore
    return null
  }
}

const defaultImageDependencies: SlidesImageGenerationDependencies = {
  generator: codexImages,
  isEnabled: () => process.env.GENOFFICE_CODEX_IMAGE_GENERATION === '1',
  confirm: confirmImageGeneration,
  getSession: (senderId) => sessions.get(senderId),
  insert: insertGeneratedImage,
}

const activeSlideImages = new Map<
  string,
  { controller: AbortController; requestId: string; generator: ImageGenerator }
>()

function imageOwnerKey(senderId: number, requestId: string): string {
  return `${senderId}:${requestId}`
}

/** Renderer-owned cancellation: another tab cannot cancel this sender's image turn. */
export function cancelSlideImageForIpc(event: IpcMainInvokeEvent, input: unknown): boolean {
  if (typeof input !== 'string' || !IMAGE_REQUEST_ID.test(input)) return false
  const active = activeSlideImages.get(imageOwnerKey(event.sender.id, input))
  if (!active) return false
  active.controller.abort(new CodexImageError('IMAGE_CANCELLED'))
  active.generator.cancel?.(active.requestId)
  return true
}

/** Testable main-only operation: confirms cost, binds cancellation, generates, then inserts. */
export async function generateSlideImageForIpc(
  event: IpcMainInvokeEvent,
  input: unknown,
  dependencies: SlidesImageGenerationDependencies = defaultImageDependencies,
): Promise<GenerateSlideImageResult> {
  const op = parseGenerateSlideImageOp(input)
  if (!op) {
    return { ok: false, code: 'IMAGE_INPUT_INVALID', error: imageError('IMAGE_INPUT_INVALID') }
  }
  if (!dependencies.isEnabled()) {
    return { ok: false, code: 'IMAGE_DISABLED', error: imageError('IMAGE_DISABLED') }
  }
  const session = dependencies.getSession(event.sender.id)
  if (!session || !session.opened.deck.slides[op.slideIndex]) {
    return { ok: false, code: 'IMAGE_INPUT_INVALID', error: imageError('IMAGE_INPUT_INVALID') }
  }
  if (
    !Number.isFinite(session.fitWidthPx) ||
    session.fitWidthPx < IMAGE_MIN_FIT_WIDTH_PX ||
    session.fitWidthPx > 10_000 ||
    Math.abs(op.fitWidthPx - session.fitWidthPx) > 0.5
  ) {
    return { ok: false, code: 'IMAGE_INPUT_INVALID', error: imageError('IMAGE_INPUT_INVALID') }
  }
  const controller = new AbortController()
  const ownerKey = imageOwnerKey(event.sender.id, op.requestId)
  // One pending confirmation or generation globally: bound modal/promise/Map usage
  // before the metered core is reached, including while the feature is disabled.
  if (activeSlideImages.size >= 1 || activeSlideImages.has(ownerKey)) {
    return { ok: false, code: 'IMAGE_BUSY', error: imageError('IMAGE_BUSY') }
  }
  activeSlideImages.set(ownerKey, {
    controller,
    requestId: op.requestId,
    generator: dependencies.generator,
  })
  const abortOnDestroyed = () => controller.abort()
  event.sender.once('destroyed', abortOnDestroyed)
  const sessionWatch = setInterval(() => {
    if (dependencies.getSession(event.sender.id) !== session) controller.abort()
  }, IMAGE_SESSION_WATCH_MS)
  sessionWatch.unref?.()
  try {
    const confirmed = await dependencies.confirm(event, op.prompt)
    if (
      !confirmed ||
      controller.signal.aborted ||
      event.sender.isDestroyed() ||
      dependencies.getSession(event.sender.id) !== session
    ) {
      return { ok: false, code: 'IMAGE_CANCELLED', error: imageError('IMAGE_CANCELLED') }
    }
    const generated = await dependencies.generator.generate(
      {
        requestId: op.requestId,
        subjectId: IMAGE_SUBJECT_ID,
        prompt: op.prompt,
        userConfirmed: true,
      },
      controller.signal,
    )
    if (controller.signal.aborted) {
      return { ok: false, code: 'IMAGE_CANCELLED', error: imageError('IMAGE_CANCELLED') }
    }
    const image = normalizeGeneratedImageForInsertion(generated)
    if (!image) {
      return { ok: false, code: 'IMAGE_OUTPUT_INVALID', error: imageError('IMAGE_OUTPUT_INVALID') }
    }
    if (
      controller.signal.aborted ||
      event.sender.isDestroyed() ||
      dependencies.getSession(event.sender.id) !== session
    ) {
      return { ok: false, code: 'IMAGE_CANCELLED', error: imageError('IMAGE_CANCELLED') }
    }
    let inserted: { slide: RenderSlide; sourceId: string } | null
    try {
      inserted = dependencies.insert(session, op, image)
    } catch {
      inserted = null
    }
    if (!inserted) {
      return { ok: false, code: 'IMAGE_INSERT_FAILED', error: imageError('IMAGE_INSERT_FAILED') }
    }
    return {
      ok: true,
      slide: inserted.slide,
      sourceId: inserted.sourceId,
      image: { mime: image.mime, width: image.width, height: image.height },
    }
  } catch (error) {
    const code: CodexImageErrorCode =
      error instanceof CodexImageError ? error.code : 'IMAGE_PROVIDER_FAILED'
    return { ok: false, code, error: imageError(code) }
  } finally {
    if (activeSlideImages.get(ownerKey)?.controller === controller)
      activeSlideImages.delete(ownerKey)
    clearInterval(sessionWatch)
    event.sender.removeListener('destroyed', abortOnDestroyed)
  }
}

async function checkCodexAccount(): Promise<{ loggedIn: boolean; error?: string }> {
  try {
    return await getCodexAccountStatus()
  } catch {
    return { loggedIn: false, error: CODEX_ACCOUNT_CHECK_ERROR }
  }
}

async function loginCodexAccount(signal?: AbortSignal): Promise<CodexAccountStatus> {
  try {
    return await loginCodex(signal)
  } catch {
    return { loggedIn: false }
  }
}

export function registerAiIpc(): void {
  ipcMain.handle('ai:get-settings', (): AiSettings => {
    return defaultAiSettings()
  })

  ipcMain.handle('ai:codex-status', (): Promise<CodexAccountStatus> => checkCodexAccount())

  ipcMain.handle('ai:codex-login', async (event): Promise<CodexAccountStatus> => {
    const controller = new AbortController()
    const abortOnDestroyed = () => controller.abort()
    event.sender.once('destroyed', abortOnDestroyed)
    try {
      return await loginCodexAccount(controller.signal)
    } finally {
      event.sender.removeListener('destroyed', abortOnDestroyed)
    }
  })

  ipcMain.handle('ai:set-settings', () => undefined)

  ipcMain.handle('ai:job-begin', (event, input: unknown) => {
    bindAiBudgetOwner(event.sender)
    return globalAiJobBudgetGate.begin(String(event.sender.id), parseAiJobId(input))
  })

  ipcMain.handle('ai:job-end', (event, input: unknown) => {
    globalAiJobBudgetGate.end(String(event.sender.id), parseAiJobBudgetTicket(input))
  })

  ipcMain.handle('ai:stream', async (event, input: unknown) => {
    const request = parseAiStreamRequest(input)
    const { requestId, system, messages } = request
    const tools = request.tools ?? []
    const provider = 'codex' as const
    const config = defaultAiSettings().providers.codex
    const send = (chunk: AiStreamChunk) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai:stream-chunk', chunk)
    }
    const owner = String(event.sender.id)
    const inputTokens = estimateAiStreamInputTokens(request)
    let budgetLease: ReturnType<typeof globalAiJobBudgetGate.acquireTurn>
    try {
      budgetLease = globalAiJobBudgetGate.acquireTurn(
        owner,
        request.job,
        requestId,
        inputTokens,
        request.maxTokens ?? 2_048,
      )
    } catch (err) {
      if (err instanceof AiJobBudgetError) {
        send({
          requestId,
          type: 'error',
          error: 'This AI task reached its 8,192-token budget. Start a new request to continue.',
          errorCode: 'budget',
        })
        return
      }
      throw err
    }
    const maxTokens = budgetLease.maxTokens
    let requestLease: ReturnType<typeof acquireAiRequest> | undefined
    let providerStarted = false
    let completed = false
    let outputText = ''
    const outputToolCalls: NonNullable<AiStreamChunk['toolCall']>[] = []
    const deadline = createAiTurnController(aiTurnTimeoutMsForReasoning(config.reasoningEffort))
    const controller = deadline.controller
    const streamKey = `${event.sender.id}:${requestId}`
    const abortOnDestroyed = () => controller.abort()
    event.sender.once('destroyed', abortOnDestroyed)
    activeAiStreams.set(streamKey, controller)
    // wire-activity keepalive: lets the renderer's silence watchdog tell a slow turn from a dead one
    let lastPing = 0
    const ping = () => {
      const now = Date.now()
      if (now - lastPing < 5_000) return
      lastPing = now
      send({ requestId, type: 'ping' })
    }
    try {
      const account = await checkCodexAccount()
      if (!account.loggedIn) {
        send({ requestId, type: 'error', error: account.error ?? tm('errCodexNotLoggedIn') })
        return
      }
      requestLease = acquireAiRequest(requestId, inputTokens + maxTokens)
      const started = await runIfAiTurnActive(
        controller.signal,
        () => event.sender.isDestroyed(),
        () => {
          providerStarted = true
          return streamForProvider(provider, config, system, messages, tools, maxTokens, {
            signal: controller.signal,
            onDelta: (text) => {
              outputText += text
              send({ requestId, type: 'delta', text })
            },
            onToolCall: (toolCall) => {
              outputToolCalls.push(toolCall)
              send({ requestId, type: 'tool-call', toolCall })
            },
            onActivity: ping,
          })
        },
      )
      if (!started) return
      completed = true
      send({ requestId, type: 'done' })
    } catch (err) {
      if (controller.signal.aborted) {
        send(
          deadline.timedOut
            ? {
                requestId,
                type: 'error',
                error: 'AI request unavailable. Try again.',
                errorCode: 'timeout',
              }
            : { requestId, type: 'done' },
        )
      } else {
        send({
          requestId,
          type: 'error',
          error: 'AI request unavailable. Try again.',
          ...(err instanceof AiTimeoutError
            ? { errorCode: 'timeout' as const }
            : err instanceof AiCreditsError
              ? { errorCode: 'credits' as const }
              : {}),
        })
      }
    } finally {
      activeAiStreams.delete(streamKey)
      event.sender.removeListener('destroyed', abortOnDestroyed)
      deadline.release()
      if (providerStarted) requestLease?.release()
      else requestLease?.rollback()
      budgetLease.settle({
        providerStarted,
        completed,
        ...(completed
          ? { outputTokens: estimateAiStreamOutputTokens(outputText, outputToolCalls) }
          : {}),
      })
    }
  })

  ipcMain.handle('ai:stream-cancel', (event, input: unknown) => {
    activeAiStreams.get(`${event.sender.id}:${parseAiRequestId(input)}`)?.abort()
  })

  // Search tools (content + images), Serper with DuckDuckGo fallback
  ipcMain.handle('ai:web-search', async (_event, query: string, maxResults?: number) => {
    try {
      return await webSearch(String(query), typeof maxResults === 'number' ? maxResults : 6)
    } catch {
      return { results: [], method: 'error', error: 'Search unavailable. Try again.' }
    }
  })

  ipcMain.handle('ai:image-search', async (_event, query: string, maxResults?: number) => {
    try {
      return await imageSearch(String(query), typeof maxResults === 'number' ? maxResults : 8)
    } catch {
      return { images: [], method: 'error', error: 'Search unavailable. Try again.' }
    }
  })
}

// ── ai:* handlers unique to slides ──────────────────────────────────────
// Must be registered inside registerSlidesIpc (not registerAiIpc): in shell aggregate mode the
// generic ai:* channels are registered by docs-main.registerAiIpc, and slides' registerAiIpc is
// never called; docs does not have these channels, so putting them in the wrong place raises
// "No handler registered".
export function registerSlidesOnlyAiIpc(): void {
  ipcMain.handle('ai:generate-slide-image', (event, input: unknown) =>
    generateSlideImageForIpc(event, input),
  )
  ipcMain.handle('ai:cancel-slide-image', (event, input: unknown) =>
    cancelSlideImageForIpc(event, input),
  )

  // Download an image from a URL and insert it into the given page (image search -> insert in one step; download in the main process avoids CORS)
  ipcMain.handle(
    'ai:insert-image-url',
    async (
      e,
      op: {
        slideIndex: number
        url: string
        xPx: number
        yPx: number
        wPx: number
        hPx: number
        fitWidthPx: number
      },
    ) => {
      if (
        !op ||
        !Number.isInteger(op.slideIndex) ||
        op.slideIndex < 0 ||
        typeof op.url !== 'string' ||
        op.url.length > 2_048 ||
        ![op.xPx, op.yPx, op.wPx, op.hPx, op.fitWidthPx].every(Number.isFinite) ||
        op.wPx <= 0 ||
        op.hPx <= 0 ||
        op.fitWidthPx <= 0 ||
        op.fitWidthPx > 10_000 ||
        [op.xPx, op.yPx, op.wPx, op.hPx].some((value) => Math.abs(value) > 100_000)
      )
        return null
      const session = sessions.get(e.sender.id)
      if (!session) return null
      const slide = session.opened.deck.slides[op.slideIndex]
      if (!slide) return null
      try {
        // the URL originates from AI tool calls (prompt-injectable via image
        // search results), so refuse non-http schemes and private/link-local
        // targets; redirects are followed manually so every hop is validated
        const image = await fetchBoundedRemoteImage(op.url, {
          maxBytes: 10 * 1024 * 1024,
          timeoutMs: 15_000,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        })
        if (!image) return null
        const ext =
          image.mime === 'image/png'
            ? 'png'
            : image.mime === 'image/gif'
              ? 'gif'
              : image.mime === 'image/webp'
                ? 'webp'
                : 'jpg'
        const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
        const scale = op.fitWidthPx / baseWidthPx
        const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
        pushHistory(session)
        const el = addPicture(session.opened, slide, {
          bytes: image.bytes,
          ext,
          offset: {
            x: toEmu(op.xPx),
            y: toEmu(op.yPx),
            cx: Math.max(1, toEmu(op.wPx)),
            cy: Math.max(1, toEmu(op.hPx)),
          },
        })
        if (!el) {
          session.undoStack.pop()
          return null
        }
        session.fitWidthPx = op.fitWidthPx
        const rebuilt = rebuildSlide(session, op.slideIndex)
        return rebuilt ? { slide: rebuilt, sourceId: el.id } : null
      } catch {
        return null
      }
    },
  )

  // ── Style Skill sidecar persistence: write a same-named .styleskill.json next to the draft (fail-open)
  ipcMain.handle(
    'ai:save-sidecar',
    async (
      event,
      data: { topic: string; styleSkill: string; createdAt: string },
    ): Promise<{ ok: boolean }> => {
      try {
        const session = sessions.get(event.sender.id)
        const draftPath = session?.path
        if (!draftPath || !draftPath.endsWith('.pptx')) return { ok: false }
        const sidecarPath = draftPath.replace(/\.pptx$/i, '.styleskill.json')
        writeFileSync(sidecarPath, JSON.stringify(data, null, 2))
        return { ok: true }
      } catch {
        return { ok: false }
      }
    },
  )

  // ── Style template save: stored in userData/style-templates/<name>.json
  const STYLE_TEMPLATES_DIR = () => join(app.getPath('userData'), 'style-templates')

  ipcMain.handle(
    'ai:save-style-template',
    (
      _event,
      name: string,
      data: { topic: string; styleSkill: string; createdAt: string },
    ): { ok: boolean; error?: string } => {
      try {
        const dir = STYLE_TEMPLATES_DIR()
        mkdirSync(dir, { recursive: true })
        // Filename: replace illegal characters in the name with _ then truncate to 64 chars
        const safeName = name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 64)
        if (!safeName) return { ok: false, error: tm('errTplNameInvalid') }
        writeJson(join(dir, `${safeName}.json`), { ...data, name: safeName })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  // ── Style template list
  ipcMain.handle(
    'ai:list-style-templates',
    (): Array<{ name: string; topic: string; createdAt: string }> => {
      try {
        const dir = STYLE_TEMPLATES_DIR()
        if (!existsSync(dir)) return []
        const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
        return files
          .map((f) => {
            try {
              const raw = readJson<{
                name?: string
                topic?: string
                createdAt?: string
                styleSkill?: string
              }>(join(dir, f), {})
              return {
                name: raw.name ?? f.replace(/\.json$/, ''),
                topic: raw.topic ?? '',
                createdAt: raw.createdAt ?? '',
              }
            } catch {
              return null
            }
          })
          .filter(Boolean) as Array<{ name: string; topic: string; createdAt: string }>
      } catch {
        return []
      }
    },
  )

  // ── Style template load
  ipcMain.handle(
    'ai:load-style-template',
    (
      _event,
      name: string,
    ): { ok: boolean; styleSkill?: string; topic?: string; error?: string } => {
      try {
        const dir = STYLE_TEMPLATES_DIR()
        const safeName = name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 64)
        const filePath = join(dir, `${safeName}.json`)
        if (!existsSync(filePath)) return { ok: false, error: tm('errTplMissing', { name }) }
        const raw = readJson<{ styleSkill?: string; topic?: string }>(filePath, {})
        if (!raw.styleSkill) return { ok: false, error: tm('errTplNoSkill', { name }) }
        return { ok: true, styleSkill: raw.styleSkill, topic: raw.topic ?? '' }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )
}
