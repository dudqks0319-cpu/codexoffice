/**
 * Design-tab theme gallery round-trip verification (= the engine path of the slides:apply-theme handler):
 * bake unsaved edits -> rewrite theme*.xml + remap explicit colors (entry surgery) ->
 * savePptx -> openPptx reparse. Scheme-referenced colors follow the new theme; explicit colors
 * are remapped wholesale to the new palette (neutrals along the dk1<->lt1 axis, chromatic colors
 * change hue while keeping lightness).
 */
import { describe, it, expect } from 'vitest'
import {
  addElement,
  applyThemeToArchive,
  buildColorMap,
  createBlankPptx,
  escapeXmlAttr,
  openPptx,
  parseTheme,
  patchThemeXml,
  recolorXml,
  remapDeckColors,
  savePptx,
  setSlideBackground,
  type TextElement,
} from '@genoffice/pptx-engine'
import { buildRenderSlide } from '@genoffice/pptx-render'
import { THEME_PRESETS } from '../src/renderer/themes'

const FIT = 1280

const graphite = THEME_PRESETS.find((t) => t.id === 'graphite')!

describe('patchThemeXml', () => {
  it('rewrites clrScheme (incl. sysClr slots) and latin fonts, keeps EA fonts', async () => {
    const opened = await openPptx(await createBlankPptx())
    const xml = opened.archive.readText('ppt/theme/theme1.xml')!

    const out = patchThemeXml(xml, {
      name: 'Graphite',
      colors: graphite.colors,
      majorFont: 'Segoe UI',
      minorFont: 'Segoe UI',
    })
    // dk1/lt1 were originally sysClr; after replacement they're uniformly srgbClr
    expect(out).toContain('<a:dk1><a:srgbClr val="F2F2F2"/></a:dk1>')
    expect(out).toContain('<a:lt1><a:srgbClr val="1E1E1E"/></a:lt1>')
    expect(out).toContain('<a:accent1><a:srgbClr val="4FC3F7"/></a:accent1>')
    expect(out).toContain('<a:clrScheme name="Graphite">')
    // Latin font replaced, East Asian kept
    expect(out).toMatch(/<a:majorFont><a:latin typeface="Segoe UI"\/>/)
    expect(out).toContain('<a:ea typeface="Microsoft YaHei"/>')

    const parsed = parseTheme(out)
    expect(parsed.colors.dk1).toBe('#F2F2F2')
    expect(parsed.colors.accent2).toBe('#FFB74D')
    expect(parsed.majorFont).toBe('Segoe UI')
    expect(parsed.majorEaFont).toBe('Microsoft YaHei')
  })

  it('treats replacement metacharacters as plain escaped theme text', async () => {
    const opened = await openPptx(await createBlankPptx())
    const xml = opened.archive.readText('ppt/theme/theme1.xml')!
    for (const value of ['$&', '$`', "$'", 'Quoted " & value']) {
      const out = patchThemeXml(xml, {
        name: value,
        colors: graphite.colors,
        majorFont: value,
        minorFont: value,
      })
      const escaped = escapeXmlAttr(value)
      expect(out).toContain(`<a:clrScheme name="${escaped}">`)
      expect(out).toContain(`<a:latin typeface="${escaped}"/>`)
    }
  })

  it('patches destination theme overrides in place without expanding or replacing them', async () => {
    const opened = await openPptx(await createBlankPptx())
    const overridePath = 'ppt/theme/themeOverride1.xml'
    const overrideRelsPath = 'ppt/theme/_rels/themeOverride1.xml.rels'
    const fmtScheme =
      '<a:fmtScheme name="Keep Format"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst></a:fmtScheme>'
    const extLst =
      '<a:extLst><a:ext uri="keep"><keep:payload xmlns:keep="urn:keep"/>' +
      '<a:accent1><a:srgbClr val="ABCDEF"/></a:accent1></a:ext></a:extLst>'
    const override =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<a:themeOverride xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<a:clrScheme name="Local Override">' +
      '<a:accent1><a:srgbClr val="112233"/></a:accent1>' +
      '<a:accent2><a:srgbClr val="445566"/></a:accent2>' +
      '</a:clrScheme>' +
      '<a:fontScheme name="Local Fonts">' +
      '<a:majorFont><a:latin typeface="Old Major"/><a:ea typeface="Old EA"/></a:majorFont>' +
      '</a:fontScheme>' +
      fmtScheme +
      extLst +
      '</a:themeOverride>'
    const overrideRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="urn:keep" Target="../media/image1.png"/>' +
      '</Relationships>'
    opened.archive.entries.set(overridePath, Buffer.from(override, 'utf8'))
    opened.archive.entries.set(overrideRelsPath, Buffer.from(overrideRels, 'utf8'))

    expect(
      applyThemeToArchive(opened, {
        name: graphite.name,
        colors: graphite.colors,
        majorFont: 'Segoe UI',
        majorEaFont: 'Microsoft YaHei',
      }),
    ).toBe(2)

    const base = opened.archive.readText('ppt/theme/theme1.xml')!
    expect(parseTheme(base).colors.accent1).toBe('#4FC3F7')
    const patchedOverride = opened.archive.readText(overridePath)!
    expect(patchedOverride).toContain('<a:clrScheme name="Graphite">')
    expect(patchedOverride).toContain('<a:accent1><a:srgbClr val="4FC3F7"/></a:accent1>')
    expect(patchedOverride).toContain('<a:accent2><a:srgbClr val="FFB74D"/></a:accent2>')
    expect(patchedOverride).not.toContain('<a:accent3>')
    expect(patchedOverride).toContain('<a:latin typeface="Segoe UI"/>')
    expect(patchedOverride).toContain('<a:ea typeface="Microsoft YaHei"/>')
    expect(patchedOverride).not.toContain('<a:minorFont>')
    expect(patchedOverride).toContain(fmtScheme)
    expect(patchedOverride).toContain(extLst)
    expect(opened.archive.readText(overrideRelsPath)).toBe(overrideRels)

    const reopened = await openPptx(await savePptx(opened))
    expect(reopened.archive.readText(overridePath)).toBe(patchedOverride)
    expect(reopened.archive.readText(overrideRelsPath)).toBe(overrideRels)
  })
})

/** Test helper: #RRGGBB -> HSL (independent of the engine implementation, coarse hue/lightness checks) */
function hsl(hex: string): { h: number; s: number; l: number } {
  const h6 = hex.replace(/^#/, '')
  const r = parseInt(h6.slice(0, 2), 16) / 255
  const g = parseInt(h6.slice(2, 4), 16) / 255
  const b = parseInt(h6.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === r) h = 60 * (((g - b) / d) % 6)
  else if (max === g) h = 60 * ((b - r) / d + 2)
  else h = 60 * ((r - g) / d + 4)
  return { h: h < 0 ? h + 360 : h, s, l }
}

describe('buildColorMap / recolorXml (explicit color remapping)', () => {
  const spec = { name: graphite.name, colors: graphite.colors }

  it('neutrals bucketed along the dk1↔lt1 axis, chromatic colors mapped to accents by frequency with luminance preserved', () => {
    const map = buildColorMap(
      new Map([
        ['FFFFFF', 9], // white -> lt1
        ['217346', 5], // most frequent chromatic color -> accent1
        ['000000', 3], // black -> dk1
        ['C00000', 2], // second most frequent chromatic color (distant hue) -> accent2
        ['888888', 1], // mid gray -> dk2
      ]),
      spec,
    )
    expect(map.get('FFFFFF')).toBe(graphite.colors.lt1)
    expect(map.get('000000')).toBe(graphite.colors.dk1)
    expect(map.get('888888')).toBe(graphite.colors.dk2)

    // Green -> accent1 (4FC3F7 blue) hue, lightness keeps its original value (dark green -> dark blue)
    const green = hsl('217346')
    const mapped1 = hsl(map.get('217346')!)
    expect(Math.abs(mapped1.h - hsl(graphite.colors.accent1!).h)).toBeLessThan(3)
    expect(Math.abs(mapped1.l - green.l)).toBeLessThan(0.02)

    // Red -> accent2 (FFB74D orange) hue
    const mapped2 = hsl(map.get('C00000')!)
    expect(Math.abs(mapped2.h - hsl(graphite.colors.accent2!).h)).toBeLessThan(3)
  })

  it('light/dark variants of the same hue join one cluster (mapped to different luminances of the same accent)', () => {
    const map = buildColorMap(
      new Map([
        ['1E5C31', 6], // dark green
        ['E8F2EB', 4], // light green tint — low saturation but not gray; a light-tier neutral verdict is acceptable
        ['3C9A5F', 2], // mid green
      ]),
      spec,
    )
    const a1h = hsl(graphite.colors.accent1!).h
    for (const src of ['1E5C31', '3C9A5F']) {
      expect(Math.abs(hsl(map.get(src)!).h - a1h)).toBeLessThan(3)
      expect(Math.abs(hsl(map.get(src)!).l - hsl(src).l)).toBeLessThan(0.02)
    }
  })

  it('recolorXml only touches srgbClr val, leaves other val attributes alone', () => {
    const xml =
      '<p:sp><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>' +
      '<a:spcPct val="100000"/><a:gd name="adj" fmla="val 50000"/></p:sp>'
    const out = recolorXml(xml, new Map([['FFFFFF', '1E1E1E']]))
    expect(out).toContain('<a:srgbClr val="1E1E1E"/>')
    expect(out).toContain('<a:spcPct val="100000"/>')
    expect(out).toContain('fmla="val 50000"')
  })
})

describe('apply-theme round trip (bake → surgical patch → save → reopen and reparse)', () => {
  it('theme + explicit color remapping survive save+reopen', async () => {
    let opened = await openPptx(await createBlankPptx())
    const spec = {
      name: graphite.name,
      colors: graphite.colors,
      majorFont: graphite.majorFont!,
      minorFont: graphite.minorFont!,
    }

    // Shape with an explicit dark-green fill + explicit white background (typical AI-generated deck palette)
    addElement(opened.deck.slides[0]!, {
      kind: 'rect',
      offset: { x: 914400, y: 914400, cx: 1828800, cy: 914400 },
      fillColor: '#217346',
    })
    setSlideBackground(opened.deck.slides[0]!, '#FFFFFF')

    // = handler flow: bake unsaved edits first, then do the entry surgery
    opened = await openPptx(await savePptx(opened))
    const patched = applyThemeToArchive(opened, spec)
    expect(patched).toBe(1)
    expect(remapDeckColors(opened, spec)).toBeGreaterThan(0)

    const reopened = await openPptx(await savePptx(opened))

    // theme part now carries the new palette
    const themeXml = reopened.archive.readText('ppt/theme/theme1.xml')!
    expect(parseTheme(themeXml).colors.lt1).toBe('#1E1E1E')
    expect(parseTheme(themeXml).minorFont).toBe('Segoe UI')

    // Explicit white background remapped to the theme base color
    const s0 = reopened.deck.slides[0]!
    expect(s0.background).toEqual({ type: 'solid', color: '#1E1E1E' })
    const rendered = buildRenderSlide(s0, reopened.deck.size, { fitWidthPx: FIT })
    expect(rendered.background).toEqual({ kind: 'solid', color: '#1E1E1E' })

    // Explicit dark-green fill -> accent1 hue (blue), lightness kept (still dark)
    const rect = s0.elements.find((e) => e.type === 'shape') as TextElement
    expect(rect.fill?.type).toBe('solid')
    const fill = hsl((rect.fill as { color: string }).color)
    expect(Math.abs(fill.h - hsl(graphite.colors.accent1!).h)).toBeLessThan(3)
    expect(Math.abs(fill.l - hsl('217346').l)).toBeLessThan(0.02)
  })

  it('every built-in preset has all 12 slots filled with valid hex', () => {
    const keys = [
      'dk1',
      'lt1',
      'dk2',
      'lt2',
      'accent1',
      'accent2',
      'accent3',
      'accent4',
      'accent5',
      'accent6',
      'hlink',
      'folHlink',
    ]
    for (const preset of THEME_PRESETS) {
      for (const k of keys) {
        expect(preset.colors[k], `${preset.id}.${k}`).toMatch(/^[0-9A-F]{6}$/i)
      }
    }
  })
})
