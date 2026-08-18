import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { createReadStream } from 'node:fs'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { BrowserWindow, app, protocol, session } from 'electron'

import { PDF_JOB_CHANNELS, PDF_JOB_SCHEME } from '../shared/job'
import type {
  PdfJobDispatchEnvelope,
  PdfJobEnvelope,
  PdfJobReply,
  PdfTransformJob,
  PdfTransformResult,
} from '../shared/job'
import {
  PDF_EDIT_MAX_PAGES,
  PDF_JOB_CHUNK_BYTES,
  PDF_JOB_MAX_WORKING_SET_KIB,
  PDF_MAX_JOB_OUTPUT_BYTES,
} from '../shared/limits'
import {
  readValidatedPdfJobOutput,
  stagePdfJobSources,
  writeCappedPdfJobOutput,
} from './pdf-job-files'
import { PdfJobQueue } from './pdf-job-runner'
import type { PdfJobProcess } from './pdf-job-runner'
import { startPdfJobMemoryWatchdog } from './pdf-job-memory'

const JOB_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${PDF_JOB_SCHEME}:; img-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; script-src 'none'; style-src 'none'; base-uri 'none'; form-action 'none'"></head><body></body></html>`
const JOB_URL = `data:text/html;charset=utf-8,${encodeURIComponent(JOB_HTML)}`

let jobPreloadPath = ''

type PdfJobSuccessReply = Extract<PdfJobReply, { readonly ok: true }>

export function configurePdfJobPreload(path: string): void {
  jobPreloadPath = path
}

let schemeRegistered = false
if (!app.isReady()) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PDF_JOB_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
  schemeRegistered = true
}

class ElectronPdfJobProcess implements PdfJobProcess {
  private window: BrowserWindow | null = null
  private abort: ((error: Error) => void) | null = null
  private cleanup: (() => void) | null = null
  private stagedRoot: string | null = null

  async run(envelope: PdfJobEnvelope): Promise<unknown> {
    if (this.window) throw new Error('pdf: isolated job process already started')
    if (!jobPreloadPath) throw new Error('pdf: isolated job preload is not configured')

    const partition = `pdf-job-${randomUUID()}`
    const isolatedSession = session.fromPartition(partition, { cache: false })
    isolatedSession.setPermissionCheckHandler(() => false)
    isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    )
    isolatedSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (_details, callback) => callback({ cancel: true }),
    )
    isolatedSession.on('will-download', (event) => event.preventDefault())
    if (!schemeRegistered) throw new Error('pdf: isolated stream scheme was not registered')

    const root = await mkdtemp(join(tmpdir(), 'genoffice-pdf-job-'))
    await chmod(root, 0o700)
    this.stagedRoot = root
    const staged = await stagePdfJobSources(envelope.job, root)
    const inputToken = randomUUID()
    const sourceUrl = `${PDF_JOB_SCHEME}://${inputToken}/source`
    const otherUrl = `${PDF_JOB_SCHEME}://${inputToken}/other`
    const outputUrl = `${PDF_JOB_SCHEME}://${inputToken}/result`
    const outputPath = join(root, 'output.pdf')
    let outputAccepted = false
    let sourceAccepted = false
    let otherAccepted = false
    let acceptProtocolResult:
      | ((result: { ok: false } | { ok: true; byteLength: number; insertedCount?: number }) => void)
      | null = null
    isolatedSession.protocol.handle(PDF_JOB_SCHEME, async (request) => {
      const url = new URL(request.url)
      const corsHeaders = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers':
          'content-type, x-genoffice-job-id, x-genoffice-job-token, x-genoffice-job-status, x-genoffice-output-bytes, x-genoffice-inserted-count',
        'cache-control': 'no-store',
      }
      if (url.host !== inputToken) {
        return new Response(null, { status: 404, headers: corsHeaders })
      }
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders })
      }
      if (url.pathname === '/result') {
        if (request.method !== 'POST' || outputAccepted) {
          return new Response(null, { status: 409, headers: corsHeaders })
        }
        if (
          request.headers.get('x-genoffice-job-id') !== envelope.id ||
          request.headers.get('x-genoffice-job-token') !== envelope.token
        ) {
          return new Response(null, { status: 403, headers: corsHeaders })
        }
        outputAccepted = true
        const status = request.headers.get('x-genoffice-job-status')
        if (status === 'transform-failed') {
          acceptProtocolResult?.({ ok: false })
          return new Response(null, { status: 204, headers: corsHeaders })
        }
        const byteLength = Number(request.headers.get('x-genoffice-output-bytes'))
        const insertedHeader = request.headers.get('x-genoffice-inserted-count')
        const insertedCount = insertedHeader === null ? undefined : Number(insertedHeader)
        if (
          status !== 'ok' ||
          !Number.isSafeInteger(byteLength) ||
          byteLength <= 0 ||
          byteLength > PDF_MAX_JOB_OUTPUT_BYTES ||
          (envelope.job.kind === 'insert' &&
            (!Number.isSafeInteger(insertedCount) ||
              (insertedCount as number) < 0 ||
              (insertedCount as number) > PDF_EDIT_MAX_PAGES)) ||
          (envelope.job.kind !== 'insert' && insertedCount !== undefined)
        ) {
          acceptProtocolResult?.({ ok: false })
          return new Response(null, { status: 400, headers: corsHeaders })
        }
        try {
          const written = await writeCappedPdfJobOutput(request.body, outputPath)
          if (written !== byteLength) throw new Error('pdf: invalid isolated job output')
          acceptProtocolResult?.({
            ok: true,
            byteLength,
            ...(insertedCount === undefined ? {} : { insertedCount }),
          })
          return new Response(null, { status: 204, headers: corsHeaders })
        } catch {
          acceptProtocolResult?.({ ok: false })
          return new Response(null, { status: 413, headers: corsHeaders })
        }
      }
      if (request.method !== 'GET' || (url.pathname !== '/source' && url.pathname !== '/other')) {
        return new Response(null, { status: 404, headers: corsHeaders })
      }
      if (url.pathname === '/source') {
        if (sourceAccepted) return new Response(null, { status: 409, headers: corsHeaders })
        sourceAccepted = true
      } else {
        if (otherAccepted) return new Response(null, { status: 409, headers: corsHeaders })
        otherAccepted = true
      }
      const target = url.pathname === '/source' ? staged.sourcePath : staged.otherPath
      const targetLength =
        url.pathname === '/source'
          ? envelope.job.source.byteLength
          : envelope.job.kind === 'insert'
            ? envelope.job.other.byteLength
            : undefined
      if (!target) return new Response(null, { status: 404, headers: corsHeaders })
      return new Response(Readable.toWeb(createReadStream(target)) as ReadableStream, {
        status: 200,
        headers: {
          ...corsHeaders,
          'content-type': 'application/pdf',
          'content-length': String(targetLength),
        },
      })
    })
    const dispatchJob: PdfJobDispatchEnvelope['job'] =
      envelope.job.kind === 'save'
        ? { kind: 'save', sourceUrl, request: envelope.job.request }
        : envelope.job.kind === 'extract'
          ? { kind: 'extract', sourceUrl, pages: envelope.job.pages }
          : { kind: 'insert', sourceUrl, otherUrl, afterPageIndex: envelope.job.afterPageIndex }
    const dispatch: PdfJobDispatchEnvelope = {
      id: envelope.id,
      token: envelope.token,
      deadlineAt: envelope.deadlineAt,
      job: dispatchJob,
      outputUrl,
    }

    const win = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      skipTaskbar: true,
      webPreferences: {
        preload: jobPreloadPath,
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
      },
    })
    this.window = win
    win.removeMenu()
    const contents = win.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-redirect', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())

    return new Promise((resolve, reject) => {
      let settled = false
      let dispatched = false
      let stopMemoryWatchdog: (() => void) | null = null
      const removeListeners = () => {
        stopMemoryWatchdog?.()
        stopMemoryWatchdog = null
        contents.removeListener('dom-ready', onReady)
        contents.removeListener('render-process-gone', onGone)
        contents.removeListener('did-fail-load', onLoadFailed)
        win.removeListener('unresponsive', onUnresponsive)
      }
      const settle = (error?: Error, value?: unknown) => {
        if (settled) return
        settled = true
        removeListeners()
        this.abort = null
        this.cleanup = null
        if (error) reject(error)
        else resolve(value)
      }
      const onReady = () => {
        if (dispatched || contents.isDestroyed()) return
        dispatched = true
        stopMemoryWatchdog = startPdfJobMemoryWatchdog({
          limitKiB: memoryLimitKiB,
          pollMs: 25,
          maxUnavailableSamples: 4,
          readWorkingSetKiB: () => {
            const rendererPid = contents.getOSProcessId()
            const memory = app.getAppMetrics().find((metric) => metric.pid === rendererPid)?.memory
            if (!memory) return undefined
            return Math.max(
              memory.workingSetSize,
              memory.peakWorkingSetSize,
              memory.privateBytes ?? 0,
            )
          },
          onExceeded: (observedKiB) =>
            settle(
              new Error(
                `pdf: isolated transformation exceeded its ${Math.floor(memoryLimitKiB / 1024)}MB memory limit (${Math.ceil(observedKiB / 1024)}MB observed)`,
              ),
            ),
          onUnavailable: () =>
            settle(new Error('pdf: isolated transformation memory metrics unavailable')),
        })
        if (settled) return
        contents.send(PDF_JOB_CHANNELS.run, dispatch)
      }
      acceptProtocolResult = (result) => {
        if (!result.ok) {
          settle(undefined, {
            id: envelope.id,
            token: envelope.token,
            ok: false,
            error: 'transform-failed',
          } satisfies PdfJobReply)
          return
        }
        void readValidatedPdfJobOutput(outputPath, result.byteLength).then(
          (bytes) => {
            const success: PdfJobSuccessReply = {
              id: envelope.id,
              token: envelope.token,
              ok: true,
              bytes,
              byteLength: bytes.byteLength,
              chunkCount: Math.ceil(bytes.byteLength / PDF_JOB_CHUNK_BYTES),
              ...(result.insertedCount === undefined
                ? {}
                : { insertedCount: result.insertedCount }),
            }
            settle(undefined, success)
          },
          (error: unknown) =>
            settle(error instanceof Error ? error : new Error('pdf: invalid isolated job output')),
        )
      }
      const onGone = () => settle(new Error('pdf: isolated transformation process exited'))
      const onUnresponsive = () => settle(new Error('pdf: isolated transformation process hung'))
      const onLoadFailed = (
        _event: Electron.Event,
        _errorCode: number,
        _errorDescription: string,
        _validatedUrl: string,
        isMainFrame: boolean,
      ) => {
        if (isMainFrame) settle(new Error('pdf: isolated transformation process failed to load'))
      }

      this.abort = (error) => settle(error)
      this.cleanup = removeListeners
      const testLimit = Number(process.env.GENOFFICE_PDF_JOB_TEST_MEMORY_LIMIT_KIB)
      const memoryLimitKiB =
        !app.isPackaged && Number.isSafeInteger(testLimit) && testLimit > 0
          ? Math.min(PDF_JOB_MAX_WORKING_SET_KIB, testLimit)
          : PDF_JOB_MAX_WORKING_SET_KIB
      contents.once('dom-ready', onReady)
      contents.once('render-process-gone', onGone)
      contents.once('did-fail-load', onLoadFailed)
      win.once('unresponsive', onUnresponsive)
      void contents
        .loadURL(JOB_URL)
        .catch(() => settle(new Error('pdf: isolated transformation process failed to load')))
    })
  }

  destroy(force: boolean): void {
    const win = this.window
    this.window = null
    this.cleanup?.()
    this.cleanup = null
    const root = this.stagedRoot
    this.stagedRoot = null
    if (root) void rm(root, { recursive: true, force: true })
    this.abort?.(new Error('pdf: isolated transformation process stopped'))
    this.abort = null
    if (!win || win.isDestroyed()) return
    if (force && !win.webContents.isDestroyed()) {
      try {
        win.webContents.forcefullyCrashRenderer()
      } catch {
        // The renderer may have already exited; destroying the window below is sufficient.
      }
    }
    win.destroy()
  }
}

// One heavy transform at a time bounds staged buffers and the sandboxed pdf-lib heap.
const queue = new PdfJobQueue({
  createProcess: () => new ElectronPdfJobProcess(),
  timeoutMs: 120_000,
  maxConcurrent: 1,
  maxQueued: 1,
})

const jobsByOwner = new Map<number, Set<AbortController>>()

export function runPdfJob(
  ownerId: number,
  createJob: (signal: AbortSignal) => PdfTransformJob | Promise<PdfTransformJob>,
): Promise<PdfTransformResult> {
  if (!jobPreloadPath)
    return Promise.reject(new Error('pdf: isolated job preload is not configured'))
  const controller = new AbortController()
  const owned = jobsByOwner.get(ownerId) ?? new Set<AbortController>()
  owned.add(controller)
  jobsByOwner.set(ownerId, owned)
  return queue.runLazy(createJob, controller.signal).finally(() => {
    owned.delete(controller)
    if (owned.size === 0) jobsByOwner.delete(ownerId)
  })
}

export function cancelPdfJobs(ownerId: number): void {
  const owned = jobsByOwner.get(ownerId)
  jobsByOwner.delete(ownerId)
  for (const controller of owned ?? []) controller.abort()
}
