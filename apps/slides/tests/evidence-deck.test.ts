import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderSlide, ShapeRenderNode } from '@genoffice/pptx-render'
import {
  createSlidesSkill,
  verifyEvidenceDeckForExport,
  type DeckAccess,
} from '../src/renderer/ai/slides-skill'

const editableNode = (id: string, text: string, y: number): ShapeRenderNode =>
  ({
    id,
    sourceId: id,
    type: 'shape',
    decoration: false,
    box: { x: 40, y, w: 1100, h: 80, rotationDeg: 0 },
    fill: { kind: 'none' },
    text: {
      lines: [
        {
          runs: [
            {
              text,
              x: 8,
              baselineY: 28,
              fontFamily: 'Arial',
              fontSizePx: 24,
              color: '#000000',
              bold: false,
              italic: false,
              underline: false,
              widthPx: text.length * 12,
            },
          ],
          top: 0,
          height: 32,
        },
      ],
      insets: { l: 8, t: 4, r: 8, b: 4 },
      anchor: 'top',
      fontScale: 1,
      wrap: true,
      contentHeight: 32,
    },
  }) as unknown as ShapeRenderNode

const slide = (prefix: string, title: string): RenderSlide =>
  ({
    widthPx: 1280,
    heightPx: 720,
    nodes: [
      editableNode(`${prefix}-title`, title, 40),
      editableNode(`${prefix}-body`, 'Claim', 180),
    ],
  }) as unknown as RenderSlide

function access(slides: RenderSlide[], sourceHash = 'sha256:abc'): DeckAccess {
  return {
    getSlides: () => slides,
    getCurrent: () => 0,
    getSelectedIds: () => [],
    applySlide: () => {},
    applyDeck: () => {},
    getEvidenceSources: () => [
      {
        locator: 'workbook:1:source.xlsx',
        title: 'source.xlsx',
        hash: sourceHash,
        kind: 'workbook',
      },
    ],
    fitWidthPx: 1280,
  }
}

const notes = new Map<number, string>()

beforeEach(() => {
  notes.clear()
  ;(window as any).slidesApi = {
    webSearch: vi.fn(async () => ({
      answer: '',
      results: [
        {
          title: 'Primary source',
          url: 'https://example.com/source',
          snippet: 'Evidence snippet',
        },
      ],
    })),
    getNotes: vi.fn(async (slideIndex: number) => notes.get(slideIndex) ?? 'Presenter cue'),
    setNotes: vi.fn(async ({ slideIndex, text }: { slideIndex: number; text: string }) => {
      notes.set(slideIndex, text)
      return true
    }),
    editText: vi.fn(async () => slide('updated', 'Summary')),
  }
})

async function linkPage(
  skill: ReturnType<typeof createSlidesSkill>,
  slideIndex: number,
  prefix: string,
) {
  return await skill.executeTool!({
    id: `e-${slideIndex}`,
    name: 'set_slide_evidence',
    input: {
      slideIndex,
      claims: [
        {
          claim: `Claim ${slideIndex + 1}`,
          sourceLocator: 'workbook:1:source.xlsx',
          sourceDetail: 'Sheet1!A1:B2',
          managedObjectIds: [`${prefix}-title`, `${prefix}-body`],
        },
      ],
      managedObjectIds: [`${prefix}-title`, `${prefix}-body`],
    },
  })
}

describe('evidence-linked editable deck gate', () => {
  it('lists attachment hashes and rejects untrusted locators', async () => {
    const skill = createSlidesSkill(access([slide('s1', 'Summary')]))
    const listed = await skill.executeTool!({
      id: 'sources',
      name: 'get_evidence_sources',
      input: {},
    })
    expect(listed.output).toContain('workbook:1:source.xlsx')
    expect(listed.output).toContain('sha256:abc')

    const rejected = await skill.executeTool!({
      id: 'bad',
      name: 'set_slide_evidence',
      input: {
        slideIndex: 0,
        claims: [
          {
            claim: 'Claim',
            sourceLocator: 'workbook:untrusted.xlsx',
            sourceDetail: 'Sheet1!A1',
            managedObjectIds: ['s1-title'],
          },
        ],
        managedObjectIds: ['s1-title'],
      },
    })
    expect(rejected.isError).toBe(true)
    expect((window as any).slidesApi.setNotes).not.toHaveBeenCalled()
  })

  it('preserves other notes and verifies the exact editable three-page structure', async () => {
    const slides = [
      slide('s1', 'Summary'),
      slide('s2', 'Analysis'),
      slide('s3', 'Risks / Next Actions'),
    ]
    const skill = createSlidesSkill(access(slides))
    for (let slideIndex = 0; slideIndex < 3; slideIndex += 1) {
      const result = await linkPage(skill, slideIndex, `s${slideIndex + 1}`)
      expect(result.isError).toBeUndefined()
    }
    expect(notes.get(0)).toContain('Presenter cue\n\n[GenOffice Evidence]')

    const verified = await skill.executeTool!({
      id: 'verify',
      name: 'verify_evidence_deck',
      input: {},
    })
    expect(verified).toMatchObject({ mutated: false })
    expect(verified.isError).toBeUndefined()
    await expect(
      verifyEvidenceDeckForExport(
        slides,
        async (index) => notes.get(index) ?? '',
        async () => new Map([['workbook:1:source.xlsx', 'sha256:abc']]),
      ),
    ).resolves.toEqual({ ok: true })

    slides[0]!.nodes[0]!.box.x += 1
    await expect(
      verifyEvidenceDeckForExport(
        slides,
        async (index) => notes.get(index) ?? '',
        async () => new Map([['workbook:1:source.xlsx', 'sha256:abc']]),
      ),
    ).resolves.toMatchObject({ ok: false })
  })

  it('fails closed for changed native content, source hash, or evidence notes', async () => {
    const slides = [
      slide('s1', 'Summary'),
      slide('s2', 'Analysis'),
      slide('s3', 'Risks / Next Actions'),
    ]
    const sourceHash = { value: 'sha256:abc' }
    const deckAccess = access(slides)
    deckAccess.getEvidenceSources = () => [
      {
        locator: 'workbook:1:source.xlsx',
        title: 'source.xlsx',
        hash: sourceHash.value,
        kind: 'workbook',
      },
    ]
    const skill = createSlidesSkill(deckAccess)
    for (let slideIndex = 0; slideIndex < 3; slideIndex += 1) {
      await linkPage(skill, slideIndex, `s${slideIndex + 1}`)
    }

    slides[0]!.nodes[1] = editableNode('s1-body', 'Changed claim', 180)
    const changed = await skill.executeTool!({ id: 'v1', name: 'verify_evidence_deck', input: {} })
    expect(changed.output).toContain('stale')

    slides[0]!.nodes[1] = editableNode('s1-body', 'Claim', 180)
    sourceHash.value = 'sha256:new'
    const sourceChanged = await skill.executeTool!({
      id: 'v2',
      name: 'verify_evidence_deck',
      input: {},
    })
    expect(sourceChanged.output).toContain('source is stale')

    sourceHash.value = 'sha256:abc'
    notes.set(0, 'tampered')
    const tampered = await skill.executeTool!({
      id: 'v3',
      name: 'verify_evidence_deck',
      input: {},
    })
    expect(tampered.output).toContain('notes are missing or changed')
  })

  it('refreshes only evidence-managed objects', async () => {
    const skill = createSlidesSkill(access([slide('s1', 'Summary')]))
    await linkPage(skill, 0, 's1')

    const rejected = await skill.executeTool!({
      id: 'refresh-user-owned',
      name: 'refresh_managed_text',
      input: { slideIndex: 0, sourceId: 'user-owned', paragraphs: [{ text: 'No' }] },
    })
    expect(rejected.isError).toBe(true)
    expect((window as any).slidesApi.editText).not.toHaveBeenCalled()

    const refreshed = await skill.executeTool!({
      id: 'refresh-managed',
      name: 'refresh_managed_text',
      input: { slideIndex: 0, sourceId: 's1-body', paragraphs: [{ text: 'Updated' }] },
    })
    expect(refreshed.isError).toBeUndefined()
    expect((window as any).slidesApi.editText).toHaveBeenCalledWith(
      expect.objectContaining({ slideIndex: 0, sourceId: 's1-body' }),
    )
  })

  it('fails closed when evidence is missing or the page count is wrong', async () => {
    const three = createSlidesSkill(
      access([
        slide('s1', 'Summary'),
        slide('s2', 'Analysis'),
        slide('s3', 'Risks / Next Actions'),
      ]),
    )
    const missing = await three.executeTool!({
      id: 'verify',
      name: 'verify_evidence_deck',
      input: {},
    })
    expect(missing.isError).toBe(true)
    expect(missing.output).toContain('missing verified evidence')

    const two = createSlidesSkill(access([slide('s1', 'Summary'), slide('s2', 'Analysis')]))
    const wrongCount = await two.executeTool!({
      id: 'verify',
      name: 'verify_evidence_deck',
      input: {},
    })
    expect(wrongCount.isError).toBe(true)
    expect(wrongCount.output).toContain('exactly 3 pages')
  })
})
