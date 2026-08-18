import { symlinkSync, truncateSync, unlinkSync } from 'node:fs'
import type JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { AttachmentPathGrants } from '../src/attachment-path-grants'
import {
  assertPdfPageCount,
  assertParseInputSize,
  assertSafeArchive,
  PARSE_MAX_ARCHIVE_ENTRIES,
  PARSE_MAX_ARCHIVE_EXPANDED_BYTES,
  PARSE_MAX_ARCHIVE_PART_BYTES,
  PARSE_MAX_INPUT_BYTES,
  PARSE_MAX_PDF_PAGES,
  PARSE_MAX_TEXT_BYTES,
  TextBudget,
} from '../src/limits'
import { parseFileToText } from '../src/parse'
import { writeFixture } from './helpers/fixtures'

function fakeZip(entries: Array<[string, number]>): JSZip {
  return {
    files: Object.fromEntries(
      entries.map(([name, uncompressedSize]) => [
        name,
        { dir: false, _data: { uncompressedSize } },
      ]),
    ),
  } as unknown as JSZip
}

describe('attachment parsing limits', () => {
  it('accepts the exact input limit and rejects one byte more', () => {
    expect(() => assertParseInputSize(PARSE_MAX_INPUT_BYTES)).not.toThrow()
    expect(() => assertParseInputSize(PARSE_MAX_INPUT_BYTES + 1)).toThrow(/50 MB parsing limit/)
  })

  it('rejects an oversized sparse file before reading it', async () => {
    const path = writeFixture('oversized.txt', '')
    truncateSync(path, PARSE_MAX_INPUT_BYTES + 1)
    const result = await parseFileToText(path)
    expect(result).toMatchObject({ ok: false, kind: 'text' })
    expect(result.error).toMatch(/50 MB parsing limit/)
  })

  it('rejects excessive ZIP entry counts', () => {
    const entries = Array.from({ length: PARSE_MAX_ARCHIVE_ENTRIES + 1 }, (_, index) => [
      `xl/worksheets/sheet${index}.xml`,
      0,
    ]) as Array<[string, number]>
    expect(() => assertSafeArchive(fakeZip(entries), 'xlsx')).toThrow(/too many entries/)
  })

  it('rejects oversized ZIP parts and total expansion', () => {
    expect(() =>
      assertSafeArchive(
        fakeZip([['ppt/slides/slide1.xml', PARSE_MAX_ARCHIVE_PART_BYTES + 1]]),
        'pptx',
      ),
    ).toThrow(/archive part exceeds/)

    const entryCount =
      Math.floor(PARSE_MAX_ARCHIVE_EXPANDED_BYTES / PARSE_MAX_ARCHIVE_PART_BYTES) + 1
    const entries = Array.from({ length: entryCount }, (_, index) => [
      `word/media/item${index}.bin`,
      PARSE_MAX_ARCHIVE_PART_BYTES,
    ]) as Array<[string, number]>
    expect(() => assertSafeArchive(fakeZip(entries), 'docx')).toThrow(/expanded archive exceeds/)
  })

  it('rejects unsafe archive paths and over-budget extracted text', () => {
    expect(() => assertSafeArchive(fakeZip([['../outside.xml', 1]]), 'xlsx')).toThrow(/unsafe path/)

    const budget = new TextBudget()
    budget.add('a'.repeat(PARSE_MAX_TEXT_BYTES))
    expect(() => budget.add('b')).toThrow(/Extracted text exceeds/)
  })

  it('rejects pathological PDF page counts before page extraction', () => {
    expect(() => assertPdfPageCount(PARSE_MAX_PDF_PAGES)).not.toThrow()
    expect(() => assertPdfPageCount(PARSE_MAX_PDF_PAGES + 1)).toThrow(/more than 2,000 pages/)
  })
})

describe('attachment path grants', () => {
  it('isolates grants by owner and rejects ungranted paths', () => {
    const allowed = writeFixture('allowed.txt', 'allowed')
    const ungranted = writeFixture('ungranted.txt', 'ungranted')
    const grants = new AttachmentPathGrants()
    const [canonical] = grants.grant(7, [allowed])

    expect(grants.resolve(7, canonical!)).toBe(canonical)
    expect(grants.resolve(8, canonical!)).toBeNull()
    expect(grants.resolve(7, ungranted)).toBeNull()

    grants.clear(7)
    expect(grants.resolve(7, canonical!)).toBeNull()
  })

  it('rejects a granted path if it is replaced with a symlink', () => {
    const original = writeFixture('replace-me.txt', 'original')
    const target = writeFixture('replacement-target.txt', 'secret')
    const grants = new AttachmentPathGrants()
    const [canonical] = grants.grant(9, [original])

    unlinkSync(original)
    symlinkSync(target, original)

    expect(grants.resolve(9, canonical!)).toBeNull()
  })
})
