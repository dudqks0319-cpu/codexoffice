import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { openPptx } from '../src/index'
import {
  PPTX_MAX_ARCHIVE_ENTRIES,
  PPTX_MAX_ARCHIVE_EXPANDED_BYTES,
  PPTX_MAX_ARCHIVE_PART_BYTES,
  PPTX_MAX_INPUT_BYTES,
  assertPptxArchiveWithinLimits,
  assertPptxInputSize,
} from '../src/zip'

function fakeZip(sizes: number[]): JSZip {
  return {
    files: Object.fromEntries(
      sizes.map((size, index) => [
        `ppt/media/item-${index}.bin`,
        {
          name: `ppt/media/item-${index}.bin`,
          dir: false,
          _data: { uncompressedSize: size },
        },
      ]),
    ),
  } as unknown as JSZip
}

describe('PPTX archive resource limits', () => {
  it('bounds the input file and declared archive expansion before inflation', () => {
    expect(() => assertPptxInputSize(PPTX_MAX_INPUT_BYTES)).not.toThrow()
    expect(() => assertPptxInputSize(PPTX_MAX_INPUT_BYTES + 1)).toThrow(
      'pptx: input file is too large',
    )
    expect(() => assertPptxInputSize(-1)).toThrow('pptx: invalid input file size')
    expect(() => assertPptxInputSize(1.5)).toThrow('pptx: invalid input file size')

    expect(() =>
      assertPptxArchiveWithinLimits(fakeZip([PPTX_MAX_ARCHIVE_PART_BYTES])),
    ).not.toThrow()
    expect(() => assertPptxArchiveWithinLimits(fakeZip([PPTX_MAX_ARCHIVE_PART_BYTES + 1]))).toThrow(
      'pptx: archive part is too large',
    )

    const safePart = Math.floor(PPTX_MAX_ARCHIVE_EXPANDED_BYTES / 5) + 1
    expect(safePart).toBeLessThanOrEqual(PPTX_MAX_ARCHIVE_PART_BYTES)
    expect(() => assertPptxArchiveWithinLimits(fakeZip(Array(5).fill(safePart)))).toThrow(
      'pptx: expanded archive is too large',
    )

    expect(() =>
      assertPptxArchiveWithinLimits(fakeZip(Array(PPTX_MAX_ARCHIVE_ENTRIES + 1).fill(0))),
    ).toThrow('pptx: archive contains too many entries')
  })

  it('rejects a real package with too many central-directory entries', async () => {
    const fixture = await import('node:fs/promises').then(({ readFile }) =>
      readFile(new URL('./fixtures/01_standard_business.pptx', import.meta.url)),
    )
    const zip = await JSZip.loadAsync(fixture)
    for (let index = 0; index <= 10_000; index += 1) {
      zip.file(`validation-extra-${index}.bin`, '', { createFolders: false })
    }
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })

    await expect(openPptx(bytes)).rejects.toThrow('pptx: archive contains too many entries')
  }, 30_000)
})
