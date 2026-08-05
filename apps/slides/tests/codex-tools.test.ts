import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderSlide } from '@genoffice/pptx-render'
import { createSlidesSkill, imageRequestId, type DeckAccess } from '../src/renderer/ai/slides-skill'
import type { AgentToolCall } from '../src/shared/ipc'

const emptySlide = {
  widthPx: 1280,
  heightPx: 720,
  nodes: [],
  background: null,
} as unknown as RenderSlide

const access: DeckAccess = {
  getSlides: () => [emptySlide],
  getCurrent: () => 0,
  getSelectedIds: () => [],
  applySlide: () => {},
  applyDeck: () => {},
  fitWidthPx: 1280,
}

describe('Codex slide tool surface', () => {
  it('keeps native image generation and removes unsupported media/cloud deck tools', () => {
    const skill = createSlidesSkill(access)
    const names = skill.tools.map((tool) => tool.name)
    expect(names).toContain('web_search')
    expect(names).toContain('image_search')
    expect(names).toContain('insert_web_image')
    expect(names).toContain('generate_image')
    expect(names).not.toContain('analyze_media')
    expect(names).not.toContain('generate_deck')
    expect(names).not.toContain('regenerate_slide')
    expect(skill.systemPrompt).toContain('Codexoffice Slides')
    expect(skill.systemPrompt).toContain('build the whole deck locally')
    expect(skill.systemPrompt).toContain('whole-page change, rebuild it')
    expect(skill.systemPrompt).toContain('Attached images can be analyzed')
    expect(skill.systemPrompt).not.toContain('AI image generation')
  })

  it('uses a stable, bounded request id for replay protection', () => {
    const id = imageRequestId('call with unsafe chars / and a very long suffix'.repeat(8))
    expect(id).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/)
    expect(id).toBe(imageRequestId('call with unsafe chars / and a very long suffix'.repeat(8)))
    expect(id).not.toBe(imageRequestId('different call'))
  })
})

describe('generate_image execution', () => {
  beforeEach(() => {
    ;(window as any).slidesApi = {
      cancelSlideImage: vi.fn(async () => true),
      generateSlideImage: vi.fn(async () => ({
        ok: true,
        slide: emptySlide,
        sourceId: 'generated-picture',
        image: { mime: 'image/png', width: 1024, height: 1024 },
      })),
    }
  })

  it('inserts the generated bitmap and returns only small metadata to the model', async () => {
    const applySlide = vi.fn()
    const skill = createSlidesSkill({ ...access, applySlide })
    const call: AgentToolCall = {
      id: 'tool-call-1',
      name: 'generate_image',
      input: { slideIndex: 0, prompt: 'A clean product photo', x: 80, y: 120, w: 480, h: 360 },
    }
    const result = await skill.executeTool!(call)
    expect(result.isError).toBeUndefined()
    expect(result.mutated).toBe(true)
    expect(applySlide).toHaveBeenCalledWith(0, emptySlide)
    expect((window as any).slidesApi.generateSlideImage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: imageRequestId(call.id),
        slideIndex: 0,
        fitWidthPx: 1280,
      }),
    )
    expect(result.output).toContain('generated-picture')
    expect(result.output).not.toContain('base64')
    expect(result.output).not.toContain('bytes')
  })

  it('surfaces confirmation/auth/capability failures without mutating the deck', async () => {
    const applySlide = vi.fn()
    const skill = createSlidesSkill({ ...access, applySlide })
    const api = (window as any).slidesApi
    const call: AgentToolCall = {
      id: 'tool-call-2',
      name: 'generate_image',
      input: { slideIndex: 0, prompt: 'Original illustration', x: 0, y: 0, w: 400, h: 300 },
    }
    for (const code of ['IMAGE_CANCELLED', 'IMAGE_SIGN_IN_REQUIRED', 'IMAGE_UNAVAILABLE']) {
      api.generateSlideImage.mockResolvedValueOnce({ ok: false, code, error: `failure: ${code}` })
      const result = await skill.executeTool!(call)
      expect(result.isError).toBe(true)
      expect(result.output).toContain(code)
    }
    expect(applySlide).not.toHaveBeenCalled()
  })

  it('forwards the agent Stop signal to the owner-bound image cancellation IPC', async () => {
    const api = (window as any).slidesApi
    api.generateSlideImage.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          const timer = setInterval(() => {
            if (api.cancelSlideImage.mock.calls.length) {
              clearInterval(timer)
              resolve({ ok: false, code: 'IMAGE_CANCELLED', error: 'cancelled' })
            }
          }, 1)
        }),
    )
    const controller = new AbortController()
    const skill = createSlidesSkill(access)
    const call: AgentToolCall = {
      id: 'tool-call-stop',
      name: 'generate_image',
      input: { slideIndex: 0, prompt: 'Stop this image', x: 0, y: 0, w: 400, h: 300 },
    }
    const pending = skill.executeTool!(call, controller.signal)
    controller.abort()
    await expect(pending).resolves.toMatchObject({ isError: true })
    expect(api.cancelSlideImage).toHaveBeenCalledWith(imageRequestId(call.id))
  })
})
