/**
 * promoteSlideBackground: full-page solid shapes at the bottom of z-order become a
 * native <p:bg> (the cloud html→pptx converter misses this when the page container
 * carries a fully transparent border — the shapes land in the deck and swallow
 * every click). Fixtures are real pptxgenjs output, run through the real
 * openPptx → promote → savePptx → openPptx chain.
 */
import { describe, it, expect } from 'vitest'
import { openPptx, savePptx } from '../src/index'
import { promoteSlideBackground, isBackgroundLikeElement } from '../src/background-promote'
import { pptxGenJsFixture } from './pptxgenjs-fixture'

describe('promoteSlideBackground', () => {
  it('promotes stacked full-page solid rects (transparent 1px border) into <p:bg>', async () => {
    const opened = await openPptx(await pptxGenJsFixture('background-stacked.pptx'))
    const slide = opened.deck.slides[0]!
    const before = slide.elements.length

    expect(promoteSlideBackground(slide, opened.deck.size)).toBe(true)
    expect(slide.elements.length).toBe(before - 2)
    expect(slide.background).toEqual({ type: 'solid', color: '#0B2545' }) // topmost wins
    expect(slide.structureDirty).toBe(true)

    const reopened = await openPptx(await savePptx(opened))
    const r = reopened.deck.slides[0]!
    expect(r.background).toEqual({ type: 'solid', color: '#0B2545' })
    expect(reopened.archive.readText(r.path)).toContain('<p:bg>')
    const texts = r.elements.flatMap(
      (el) =>
        (
          el as { text?: { paragraphs: Array<{ runs: Array<{ text: string }> }> } }
        ).text?.paragraphs?.flatMap((pg) => pg.runs.map((run) => run.text)) ?? [],
    )
    expect(texts.join(' ')).toContain('CONTENT')
  })

  it('leaves shapes with a visible border alone', async () => {
    const opened = await openPptx(await pptxGenJsFixture('background-visible-line.pptx'))
    const slide = opened.deck.slides[0]!
    const before = slide.elements.length
    expect(promoteSlideBackground(slide, opened.deck.size)).toBe(false)
    expect(slide.elements.length).toBe(before)
  })

  it('leaves non-full-page shapes and shapes with text alone', async () => {
    const opened = await openPptx(await pptxGenJsFixture('background-nonfull-text.pptx'))
    const slide = opened.deck.slides[0]!
    const before = slide.elements.length
    expect(promoteSlideBackground(slide, opened.deck.size)).toBe(false)
    expect(slide.elements.length).toBe(before)
  })

  it('skips shapes referenced by the timing tree', async () => {
    const opened = await openPptx(await pptxGenJsFixture('background-full.pptx'))
    const slide = opened.deck.slides[0]!
    const spid = /<p:cNvPr\b[^>]*\bid="(\d+)"/.exec(slide.elements[0]!.anchor.originalXml)![1]
    slide.bodySuffix = slide.bodySuffix.replace(
      '</p:sld>',
      `<p:timing><p:spTgt spid="${spid}"/></p:timing></p:sld>`,
    )
    expect(promoteSlideBackground(slide, opened.deck.size)).toBe(false)
  })

  it('isBackgroundLikeElement matches full-page fills only', async () => {
    const opened = await openPptx(await pptxGenJsFixture('background-mixed.pptx'))
    const slide = opened.deck.slides[0]!
    expect(isBackgroundLikeElement(slide.elements[0]!, opened.deck.size)).toBe(true)
    expect(isBackgroundLikeElement(slide.elements[1]!, opened.deck.size)).toBe(false)
  })
})
