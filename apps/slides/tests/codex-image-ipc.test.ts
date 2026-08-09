import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexImageError, type CodexImageResult } from '@genoffice/ai-provider/node'
import type { Session } from '../src/main/session-state'
import type { GenerateSlideImageOp } from '../src/shared/ipc'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  showMessageBox: vi.fn(async () => ({ response: 1 })),
  createFromBuffer: vi.fn((bytes: Buffer) => ({
    isEmpty: (): boolean => false,
    getSize: () => ({ width: 1024, height: 768 }),
    toPNG: () => bytes,
  })),
}))

const engine = vi.hoisted(() => ({ addPicture: vi.fn() }))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null },
  dialog: { showMessageBox: electron.showMessageBox },
  nativeImage: { createFromBuffer: electron.createFromBuffer },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) =>
      electron.handlers.set(channel, handler),
    ),
  },
}))

vi.mock('@genoffice/pptx-engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/pptx-engine')>()),
  addPicture: engine.addPicture,
}))

vi.mock('../src/main/fonts', () => ({ createSystemFontMetrics: () => ({}) }))

import {
  cancelSlideImageForIpc,
  confirmImageGeneration,
  generateSlideImageForIpc,
  insertGeneratedImage,
  normalizeGeneratedImageForInsertion,
  parseGenerateSlideImageOp,
  registerSlidesOnlyAiIpc,
  shouldAutoConfirmImageGeneration,
  type SlidesImageGenerationDependencies,
} from '../src/main/ai-ipc'

const validOp: GenerateSlideImageOp = {
  requestId: 'slides:tool-1',
  slideIndex: 0,
  prompt: 'An original watercolor landscape',
  xPx: 80,
  yPx: 100,
  wPx: 500,
  hPx: 360,
  fitWidthPx: 1280,
}

const image: CodexImageResult = {
  requestId: validOp.requestId,
  mime: 'image/png',
  bytes: Buffer.from([137, 80, 78, 71]),
  base64: 'iVBORw==',
  width: 1024,
  height: 768,
}

function makeEvent() {
  const sender = new EventEmitter() as EventEmitter & {
    id: number
    isDestroyed(): boolean
    destroyed: boolean
  }
  sender.id = 42
  sender.destroyed = false
  sender.isDestroyed = () => sender.destroyed
  return { sender } as any
}

function makeDependencies(
  overrides: Partial<SlidesImageGenerationDependencies> = {},
): SlidesImageGenerationDependencies {
  const session = {
    opened: { deck: { slides: [{}] } },
    fitWidthPx: 1280,
    undoStack: [],
    redoStack: [],
  } as unknown as Session
  return {
    isEnabled: () => true,
    confirm: vi.fn(async () => true),
    generator: { generate: vi.fn(async () => image) },
    getSession: vi.fn(() => session),
    insert: vi.fn(() => ({
      slide: { widthPx: 1280, heightPx: 720, nodes: [] } as any,
      sourceId: 'pic-1',
    })),
    ...overrides,
  }
}

describe('Codex slide image IPC', () => {
  beforeEach(() => {
    electron.handlers.clear()
    electron.showMessageBox.mockReset()
    electron.showMessageBox.mockResolvedValue({ response: 1 })
    electron.createFromBuffer.mockReset()
    electron.createFromBuffer.mockImplementation((bytes: Buffer) => ({
      isEmpty: (): boolean => false,
      getSize: () => ({ width: 1024, height: 768 }),
      toPNG: () => bytes,
    }))
    engine.addPicture.mockReset()
  })

  it('validates request ids, prompts, slide indices, and bounded geometry', () => {
    expect(parseGenerateSlideImageOp(validOp)).toEqual(validOp)
    expect(parseGenerateSlideImageOp({ ...validOp, requestId: 'unsafe id' })).toBeNull()
    expect(parseGenerateSlideImageOp({ ...validOp, prompt: '' })).toBeNull()
    expect(parseGenerateSlideImageOp({ ...validOp, prompt: 'x'.repeat(8_193) })).toBeNull()
    expect(parseGenerateSlideImageOp({ ...validOp, slideIndex: -1 })).toBeNull()
    expect(parseGenerateSlideImageOp({ ...validOp, wPx: Number.NaN })).toBeNull()
    expect(parseGenerateSlideImageOp({ ...validOp, hPx: 0 })).toBeNull()
    expect(parseGenerateSlideImageOp({ ...validOp, fitWidthPx: Number.MIN_VALUE })).toBeNull()
  })

  it('registers the main-only image generation channel', () => {
    registerSlidesOnlyAiIpc()
    expect(electron.handlers.has('ai:generate-slide-image')).toBe(true)
    expect(electron.handlers.has('ai:cancel-slide-image')).toBe(true)
  })

  it('fully decodes and normalizes the provider image before PPTX insertion', () => {
    expect(normalizeGeneratedImageForInsertion(image)).toMatchObject({
      mime: 'image/png',
      width: 1024,
      height: 768,
    })
    electron.createFromBuffer.mockReturnValueOnce({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      toPNG: () => Buffer.alloc(0),
    })
    expect(normalizeGeneratedImageForInsertion(image)).toBeNull()
  })

  it('rejects derived EMU overflow before mutating the deck', () => {
    const session = {
      opened: {
        deck: { slides: [{}], size: { cx: Number.MAX_SAFE_INTEGER, cy: 1 } },
        archive: { entries: new Map() },
      },
      fitWidthPx: 100,
      undoStack: [],
      redoStack: [],
    } as unknown as Session
    expect(insertGeneratedImage(session, { ...validOp, fitWidthPx: 100 }, image)).toBeNull()
    expect(session.undoStack).toHaveLength(0)
    expect(engine.addPicture).not.toHaveBeenCalled()
  })

  it('restores the deck and archive when insertion throws', () => {
    const originalSlide = { name: 'before' }
    const history = Array.from({ length: 50 }, (_, index) => ({
      slides: [{ name: `history-${index}` }],
      entries: new Map<string, Uint8Array>(),
      size: { cx: 12_192_000, cy: 6_858_000 },
    }))
    const expectedHistory = [...history]
    const session = {
      opened: {
        deck: { slides: [originalSlide], size: { cx: 12_192_000, cy: 6_858_000 } },
        archive: { entries: new Map([['ppt/slides/slide1.xml', new Uint8Array([1])]]) },
      },
      fitWidthPx: 1280,
      undoStack: history,
      redoStack: [],
      htmlPages: [{}],
    } as unknown as Session
    engine.addPicture.mockImplementation(() => {
      session.opened.deck.slides[0] = { name: 'mutated' } as any
      session.opened.archive.entries.set('ppt/media/image1.png', new Uint8Array([2]))
      throw new Error('codec failure')
    })
    expect(insertGeneratedImage(session, validOp, image)).toBeNull()
    expect(session.opened.deck.slides).toEqual([originalSlide])
    expect([...session.opened.archive.entries.keys()]).toEqual(['ppt/slides/slide1.xml'])
    expect(session.undoStack).toEqual(expectedHistory)
    expect(session.undoStack).toHaveLength(50)
    expect(session.htmlPages).toEqual([{}])
  })

  it('uses an explicit usage/cost dialog with cancel as the safe default', async () => {
    expect(await confirmImageGeneration(makeEvent(), validOp.prompt)).toBe(false)
    expect(electron.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Generate this image with Codex?',
        detail: expect.stringContaining('usage or incur cost'),
        defaultId: 1,
        cancelId: 1,
      }),
    )
  })

  it('auto-confirms only for an explicit packaged smoke in an isolated temp profile', () => {
    const isolatedUserData = mkdtempSync(join(realpathSync(tmpdir()), 'genoffice-image-smoke-'))
    const enabled = {
      GENOFFICE_PACKAGED_SMOKE: '1',
      GENOFFICE_SMOKE_AUTO_CONFIRM_IMAGE: '1',
      GENOFFICE_CODEX_IMAGE_GENERATION: '1',
      GENOFFICE_USER_DATA: isolatedUserData,
    }
    try {
      expect(shouldAutoConfirmImageGeneration(enabled)).toBe(true)
      expect(
        shouldAutoConfirmImageGeneration({
          ...enabled,
          GENOFFICE_USER_DATA: '/Users/example/Library/Application Support/GenOffice',
        }),
      ).toBe(false)
      expect(
        shouldAutoConfirmImageGeneration({ ...enabled, GENOFFICE_SMOKE_AUTO_CONFIRM_IMAGE: '0' }),
      ).toBe(false)
    } finally {
      rmSync(isolatedUserData, { recursive: true, force: true })
    }
  })

  it('shows the complete bounded prompt in the per-call confirmation', async () => {
    const prompt = `begin-${'x'.repeat(700)}-end`
    await confirmImageGeneration(makeEvent(), prompt)
    expect(electron.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.stringContaining(prompt) }),
    )
  })

  it('does not invoke Codex when the user cancels the per-call confirmation', async () => {
    const deps = makeDependencies({ confirm: vi.fn(async () => false) })
    const result = await generateSlideImageForIpc(makeEvent(), validOp, deps)
    expect(result).toMatchObject({ ok: false, code: 'IMAGE_CANCELLED' })
    expect(deps.generator.generate).not.toHaveBeenCalled()
    expect(deps.insert).not.toHaveBeenCalled()
  })

  it('fails before opening a confirmation dialog when image generation is disabled', async () => {
    const deps = makeDependencies({ isEnabled: () => false })
    const result = await generateSlideImageForIpc(makeEvent(), validOp, deps)
    expect(result).toMatchObject({ ok: false, code: 'IMAGE_DISABLED' })
    expect(deps.confirm).not.toHaveBeenCalled()
    expect(deps.generator.generate).not.toHaveBeenCalled()
  })

  it('allows only one pending confirmation globally across unique request ids', async () => {
    let resolveConfirmation: (confirmed: boolean) => void = () => undefined
    const confirm = vi.fn(
      async () =>
        await new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve
        }),
    )
    const firstEvent = makeEvent()
    const firstDeps = makeDependencies({ confirm })
    const first = generateSlideImageForIpc(firstEvent, validOp, firstDeps)
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))

    const secondEvent = makeEvent()
    secondEvent.sender.id = 43
    const secondDeps = makeDependencies()
    const second = await generateSlideImageForIpc(
      secondEvent,
      { ...validOp, requestId: 'slides:tool-2' },
      secondDeps,
    )
    expect(second).toMatchObject({ ok: false, code: 'IMAGE_BUSY' })
    expect(secondDeps.confirm).not.toHaveBeenCalled()
    expect(secondDeps.generator.generate).not.toHaveBeenCalled()

    resolveConfirmation(false)
    await expect(first).resolves.toMatchObject({ ok: false, code: 'IMAGE_CANCELLED' })
  })

  it('does not invoke Codex when Stop arrives while confirmation is pending', async () => {
    const event = makeEvent()
    let resolveConfirmation: (confirmed: boolean) => void = () => undefined
    const confirm = vi.fn(
      async () =>
        await new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve
        }),
    )
    const deps = makeDependencies({ confirm })
    const pending = generateSlideImageForIpc(event, validOp, deps)
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled())
    expect(cancelSlideImageForIpc(event, validOp.requestId)).toBe(true)
    resolveConfirmation(true)
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'IMAGE_CANCELLED' })
    expect(deps.generator.generate).not.toHaveBeenCalled()
    expect(deps.insert).not.toHaveBeenCalled()
  })

  it.each([
    'IMAGE_SIGN_IN_REQUIRED',
    'IMAGE_UNAVAILABLE',
    'IMAGE_DUPLICATE',
    'IMAGE_TIMEOUT',
  ] as const)('returns the guarded core failure %s without insertion', async (code) => {
    const deps = makeDependencies({
      generator: {
        generate: vi.fn(async () => {
          throw new CodexImageError(code)
        }),
      },
    })
    const result = await generateSlideImageForIpc(makeEvent(), validOp, deps)
    expect(result).toMatchObject({ ok: false, code })
    expect(deps.insert).not.toHaveBeenCalled()
  })

  it('binds cancellation to sender lifetime', async () => {
    const event = makeEvent()
    const generate = vi.fn(async (_request, signal?: AbortSignal) => {
      event.sender.destroyed = true
      event.sender.emit('destroyed')
      expect(signal?.aborted).toBe(true)
      throw new CodexImageError('IMAGE_CANCELLED')
    })
    const result = await generateSlideImageForIpc(
      event,
      validOp,
      makeDependencies({ generator: { generate } }),
    )
    expect(result).toMatchObject({ ok: false, code: 'IMAGE_CANCELLED' })
  })

  it('lets only the owning renderer cancel an active billed image turn', async () => {
    const event = makeEvent()
    const cancel = vi.fn(() => true)
    const generate = vi.fn(
      async (_request, signal?: AbortSignal): Promise<CodexImageResult> =>
        await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new CodexImageError('IMAGE_CANCELLED')), {
            once: true,
          })
        }),
    )
    const pending = generateSlideImageForIpc(
      event,
      validOp,
      makeDependencies({ generator: { generate, cancel } }),
    )
    await vi.waitFor(() => expect(generate).toHaveBeenCalled())
    const other = makeEvent()
    other.sender.id = 43
    expect(cancelSlideImageForIpc(other, validOp.requestId)).toBe(false)
    expect(cancelSlideImageForIpc(event, validOp.requestId)).toBe(true)
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'IMAGE_CANCELLED' })
    expect(cancel).toHaveBeenCalledWith(validOp.requestId)
  })

  it('refuses insertion when Stop arrives as the provider resolves', async () => {
    const event = makeEvent()
    let resolveGenerate: (value: CodexImageResult) => void = () => undefined
    const generate = vi.fn(
      async (): Promise<CodexImageResult> =>
        await new Promise((resolve) => {
          resolveGenerate = resolve
        }),
    )
    const deps = makeDependencies({ generator: { generate, cancel: vi.fn(() => true) } })
    const pending = generateSlideImageForIpc(event, validOp, deps)
    await vi.waitFor(() => expect(generate).toHaveBeenCalled())
    resolveGenerate(image)
    expect(cancelSlideImageForIpc(event, validOp.requestId)).toBe(true)
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'IMAGE_CANCELLED' })
    expect(deps.insert).not.toHaveBeenCalled()
  })

  it('aborts generation and refuses insertion when the renderer session is replaced', async () => {
    const firstSession = {
      opened: { deck: { slides: [{}] } },
      fitWidthPx: 1280,
    } as unknown as Session
    const replacementSession = {
      opened: { deck: { slides: [{}] } },
      fitWidthPx: 1280,
    } as unknown as Session
    let currentSession = firstSession
    const insert = vi.fn(() => null)
    const generate = vi.fn(
      async (_request, signal?: AbortSignal): Promise<CodexImageResult> =>
        await new Promise((_resolve, reject) => {
          currentSession = replacementSession
          signal?.addEventListener('abort', () => reject(new CodexImageError('IMAGE_CANCELLED')), {
            once: true,
          })
        }),
    )
    const result = await generateSlideImageForIpc(
      makeEvent(),
      validOp,
      makeDependencies({
        getSession: vi.fn(() => currentSession),
        generator: { generate },
        insert,
      }),
    )

    expect(result).toMatchObject({ ok: false, code: 'IMAGE_CANCELLED' })
    expect(insert).not.toHaveBeenCalled()
  })

  it('inserts validated bytes in main without exposing the raw generation response', async () => {
    const deps = makeDependencies()
    const result = await generateSlideImageForIpc(makeEvent(), validOp, deps)
    expect(deps.generator.generate).toHaveBeenCalledWith(
      {
        requestId: validOp.requestId,
        subjectId: 'slides:local-app',
        prompt: validOp.prompt,
        userConfirmed: true,
      },
      expect.any(AbortSignal),
    )
    expect(deps.insert).toHaveBeenCalledWith(expect.anything(), validOp, image)
    expect(result).toMatchObject({
      ok: true,
      sourceId: 'pic-1',
      image: { mime: 'image/png', width: 1024, height: 768 },
    })
    expect(JSON.stringify(result)).not.toContain('iVBORw')
    expect(JSON.stringify(result)).not.toContain('bytes')
  })
})
