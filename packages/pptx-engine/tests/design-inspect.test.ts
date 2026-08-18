import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { createBlankPptx, inspectPptxDesign, validateThemeSpec } from '../src/index'

function forgeUncompressedSize(bytes: Uint8Array, entryName: string, size: number): Uint8Array {
  const out = bytes.slice()
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  const decoder = new TextDecoder()
  for (let offset = 0; offset + 46 <= out.byteLength; offset++) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue
    const nameLength = view.getUint16(offset + 28, true)
    const name = decoder.decode(out.subarray(offset + 46, offset + 46 + nameLength))
    if (name !== entryName) continue
    view.setUint32(offset + 24, size, true)
    const localOffset = view.getUint32(offset + 42, true)
    view.setUint32(localOffset + 22, size, true)
    return out
  }
  throw new Error(`missing ZIP entry ${entryName}`)
}

describe('PPTX design inspection', () => {
  it('returns a sanitized, complete first-slide theme preview', async () => {
    const result = await inspectPptxDesign(await createBlankPptx(), {
      sourceName: '/tmp/\u202e\u061c\u200eunsafe\u0007\u0085 deck.pptx',
    })
    expect(result.sourceName).toBe('unsafe deck.pptx')
    expect(result.candidates).toHaveLength(1)
    expect(result.defaultCandidateId).toBe(result.candidates[0]!.id)
    expect(result.candidates[0]!.slideCount).toBe(1)
    expect(Object.keys(result.candidates[0]!.colors)).toHaveLength(12)
  })

  it('rejects a sysClr without a valid six-digit lastClr', async () => {
    const zip = await JSZip.loadAsync(await createBlankPptx())
    const path = 'ppt/theme/theme1.xml'
    const xml = await zip.file(path)!.async('string')
    zip.file(path, xml.replace(/lastClr="[0-9A-Fa-f]{6}"/, 'lastClr=""'))
    await expect(
      inspectPptxDesign(await zip.generateAsync({ type: 'uint8array' })),
    ).rejects.toThrow(/invalid theme color/)
  })

  it('requires exactly the 12 named palette slots', () => {
    expect(() => validateThemeSpec({ name: 'Incomplete', colors: { dk1: '#000000' } })).toThrow(
      /exactly the 12/,
    )
  })

  it('orders multiple themes by first slide and reports slide-use counts', async () => {
    const zip = await JSZip.loadAsync(await createBlankPptx())
    const text = async (path: string) => zip.file(path)!.async('string')
    zip.file('ppt/slides/slide2.xml', await text('ppt/slides/slide1.xml'))
    zip.file(
      'ppt/slides/_rels/slide2.xml.rels',
      (await text('ppt/slides/_rels/slide1.xml.rels')).replace(
        'slideLayout1.xml',
        'slideLayout2.xml',
      ),
    )
    zip.file('ppt/slideLayouts/slideLayout2.xml', await text('ppt/slideLayouts/slideLayout1.xml'))
    zip.file(
      'ppt/slideLayouts/_rels/slideLayout2.xml.rels',
      (await text('ppt/slideLayouts/_rels/slideLayout1.xml.rels')).replace(
        'slideMaster1.xml',
        'slideMaster2.xml',
      ),
    )
    zip.file('ppt/slideMasters/slideMaster2.xml', await text('ppt/slideMasters/slideMaster1.xml'))
    zip.file(
      'ppt/slideMasters/_rels/slideMaster2.xml.rels',
      (await text('ppt/slideMasters/_rels/slideMaster1.xml.rels')).replace(
        'theme1.xml',
        'theme2.xml',
      ),
    )
    zip.file(
      'ppt/theme/theme2.xml',
      (await text('ppt/theme/theme1.xml')).replace(
        /(<a:theme\b[^>]*\bname=)(?:"[^"]*"|'[^']*')/,
        '$1"Second"',
      ),
    )
    zip.file(
      'ppt/presentation.xml',
      (await text('ppt/presentation.xml')).replace(
        '</p:sldIdLst>',
        '<p:sldId id="257" r:id="rId99"/></p:sldIdLst>',
      ),
    )
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      (await text('ppt/_rels/presentation.xml.rels')).replace(
        '</Relationships>',
        '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
      ),
    )
    const result = await inspectPptxDesign(await zip.generateAsync({ type: 'uint8array' }))
    expect(result.candidates.map(({ name, slideCount }) => [name, slideCount])).toEqual([
      [result.candidates[0]!.name, 1],
      ['Second', 1],
    ])
    expect(result.defaultCandidateId).toBe('theme-1')
  })

  it('rejects an external required relationship', async () => {
    const zip = await JSZip.loadAsync(await createBlankPptx())
    const path = 'ppt/slides/_rels/slide1.xml.rels'
    const xml = await zip.file(path)!.async('string')
    zip.file(
      path,
      xml.replace(
        'Target="../slideLayouts/',
        'TargetMode="External" Target="https://example.invalid/',
      ),
    )
    await expect(
      inspectPptxDesign(await zip.generateAsync({ type: 'uint8array' })),
    ).rejects.toThrow(/external layout/)
  })

  it('rejects theme overrides rather than previewing the wrong base theme', async () => {
    const zip = await JSZip.loadAsync(await createBlankPptx())
    zip.file('ppt/theme/themeOverride1.xml', '<a:themeOverride/>')
    await expect(
      inspectPptxDesign(await zip.generateAsync({ type: 'uint8array' })),
    ).rejects.toThrow(/theme overrides are not supported/)
  })

  it('rejects unsafe ZIP paths even when the ZIP library normalizes their public name', async () => {
    const zip = await JSZip.loadAsync(await createBlankPptx())
    zip.file('../misleading.xml', '<x/>')
    await expect(
      inspectPptxDesign(await zip.generateAsync({ type: 'uint8array' })),
    ).rejects.toThrow(/unsafe ZIP entry path/)
  })

  it('enforces an immediate inspection deadline', async () => {
    await expect(inspectPptxDesign(await createBlankPptx(), { deadlineMs: 0 })).rejects.toThrow(
      /timed out/,
    )
  })

  it('bounds actual streamed XML expansion even when ZIP size metadata is forged', async () => {
    const path = 'ppt/theme/theme1.xml'
    const zip = await JSZip.loadAsync(await createBlankPptx())
    const xml = await zip.file(path)!.async('string')
    zip.file(path, `${xml}<!--${'x'.repeat(2 * 1024 * 1024)}-->`)
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    const forged = forgeUncompressedSize(bytes, path, 1)
    await expect(inspectPptxDesign(forged)).rejects.toThrow(/XML part is too large/)
  })
})
