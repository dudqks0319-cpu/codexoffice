import { describe, expect, it } from 'vitest'
import type { RenderSlide } from '@genoffice/pptx-render'
import { createSlidesSkill, type DeckAccess } from '../src/renderer/ai/slides-skill'

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
  it('keeps provider-independent search and removes unsupported paid media/deck tools', () => {
    const names = createSlidesSkill(access).tools.map((tool) => tool.name)
    expect(names).toContain('web_search')
    expect(names).toContain('image_search')
    expect(names).toContain('insert_web_image')
    expect(names).not.toContain('generate_image')
    expect(names).not.toContain('analyze_media')
    expect(names).not.toContain('generate_deck')
    expect(names).not.toContain('regenerate_slide')
  })
})
