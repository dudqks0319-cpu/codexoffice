/**
 * AI IPC for the slides main process, extracted from slides-main.ts:
 * settings persistence, the streaming proxy (main process does the networking
 * to avoid renderer CORS), search tools, and slides-only provider-independent tools.
 */
import { app, ipcMain } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  acquireAiRequest,
  AiCreditsError,
  AiTimeoutError,
  defaultAiSettings,
  createAiTurnController,
  getCodexAccountStatus,
  loginCodex,
  parseAiRequestId,
  parseAiStreamRequest,
  runIfAiTurnActive,
  streamForProvider,
  type AiSettings,
  type AiStreamChunk,
  type CodexAccountStatus,
} from '@genoffice/ai-provider/node'
import { fetchBoundedRemoteImage } from '@genoffice/electron-utils'
import { webSearch, imageSearch } from '@genoffice/ai-search'
import { addPicture } from '@genoffice/pptx-engine'
import { EMU_PER_PX_96 } from '@genoffice/pptx-render'
import { tm } from './i18n-main'
import { pushHistory, rebuildSlide, sessions } from './session-state'

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
const CODEX_ACCOUNT_CHECK_ERROR = "Unable to verify this app's Codex account. Try again."

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

  ipcMain.handle('ai:stream', async (event, input: unknown) => {
    const request = parseAiStreamRequest(input)
    const { requestId, system, messages } = request
    const tools = request.tools ?? []
    const maxTokens = request.maxTokens ?? 8192
    const provider = 'codex' as const
    const config = defaultAiSettings().providers.codex
    const send = (chunk: AiStreamChunk) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai:stream-chunk', chunk)
    }
    const lease = acquireAiRequest(requestId, maxTokens)
    const deadline = createAiTurnController()
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
      const started = await runIfAiTurnActive(
        controller.signal,
        () => event.sender.isDestroyed(),
        () =>
          streamForProvider(provider, config, system, messages, tools, maxTokens, {
            signal: controller.signal,
            onDelta: (text) => send({ requestId, type: 'delta', text }),
            onToolCall: (toolCall) => send({ requestId, type: 'tool-call', toolCall }),
            onActivity: ping,
          }),
      )
      if (!started) return
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
      lease.release()
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
