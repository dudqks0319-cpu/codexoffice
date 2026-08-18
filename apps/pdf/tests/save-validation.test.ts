import { describe, expect, it } from 'vitest'

import {
  parseExportImagesRequest,
  parseExtractPagesRequest,
  parseInsertPdfRequest,
  parseSavePdfRequest,
} from '../src/main/save-validation'
import type { SavePdfRequest } from '../src/shared/ipc'

const request = (overrides: Partial<SavePdfRequest> = {}): SavePdfRequest => ({
  path: '/tmp/test.pdf',
  markups: [],
  drawings: [],
  formValues: [],
  stamps: [],
  ...overrides,
})

describe('PDF save request validation', () => {
  it('returns an allowlisted DTO and drops unknown structured-clone payloads', () => {
    const input = request()
    const parsed = parseSavePdfRequest({ ...input, hidden: new Uint8Array(1024) })
    expect(parsed).not.toHaveProperty('hidden')
    expect(parsed).toEqual(input)
  })

  it('drops unknown binary payloads nested inside valid mutation objects', () => {
    const parsed = parseSavePdfRequest(
      request({
        markups: [
          {
            pageIndex: 0,
            type: 'highlight',
            color: [1, 1, 0],
            quads: [[0, 1, 2, 1, 0, 0, 2, 0]],
            hidden: new Uint8Array(1024),
          } as SavePdfRequest['markups'][number],
        ],
      }),
    )
    expect(parsed.markups[0]).not.toHaveProperty('hidden')
  })
  it('accepts the renderer request shape', () => {
    const value = request({
      auto: true,
      rotations: [{ pageIndex: 0, delta: 90 }],
      drawings: [{ kind: 'note', pageIndex: 0, color: [1, 1, 0], at: [10, 20], contents: 'x' }],
    })
    expect(parseSavePdfRequest(value)).toEqual(value)
  })

  it('rejects non-finite coordinates and malformed rotation deltas', () => {
    expect(() =>
      parseSavePdfRequest(
        request({
          markups: [
            {
              pageIndex: 0,
              type: 'highlight',
              color: [1, 1, 0],
              quads: [[0, 0, Number.NaN, 0, 0, 1, 1, 1]],
            },
          ],
        }),
      ),
    ).toThrow('markup.quad')
    expect(() =>
      parseSavePdfRequest(request({ rotations: [{ pageIndex: 0, delta: 45 }] })),
    ).toThrow('multiple of 90')
  })

  it('rejects oversized text and base64 payloads before pdf-lib sees them', () => {
    expect(() =>
      parseSavePdfRequest(
        request({
          drawings: [
            {
              kind: 'note',
              pageIndex: 0,
              color: [1, 1, 0],
              at: [0, 0],
              contents: 'x'.repeat(64 * 1024 + 1),
            },
          ],
        }),
      ),
    ).toThrow('drawing.contents')
    expect(() =>
      parseSavePdfRequest(
        request({
          stamps: [
            {
              pageIndex: 0,
              image: 'A'.repeat(14 * 1024 * 1024 + 1),
              rect: [0, 0, 1, 1],
            },
          ],
        }),
      ),
    ).toThrow('stamp.image')
  })

  it('rejects missing required arrays and unbounded page indices', () => {
    expect(() => parseSavePdfRequest({ path: '/tmp/test.pdf' })).toThrow('markups')
    expect(() => parseSavePdfRequest(request({ deletedPages: [20_000] }))).toThrow('deleted page')
  })

  it('rejects empty geometry and duplicate structural operations', () => {
    expect(() =>
      parseSavePdfRequest(
        request({
          markups: [{ pageIndex: 0, type: 'highlight', color: [1, 1, 0], quads: [] }],
        }),
      ),
    ).toThrow('markup.quads')
    expect(() =>
      parseSavePdfRequest(
        request({
          drawings: [{ kind: 'ink', pageIndex: 0, color: [0, 0, 0], width: 1, paths: [] }],
        }),
      ),
    ).toThrow('drawing.paths')
    expect(() => parseSavePdfRequest(request({ deletedPages: [1, 1] }))).toThrow(
      'duplicate deleted page',
    )
    expect(() => parseSavePdfRequest(request({ pageOrder: [0, 0] }))).toThrow(
      'duplicate page order',
    )
  })
})

describe('PDF auxiliary IPC request validation', () => {
  const pngSignature = 'iVBORw0KGgo='

  it('accepts bounded extract, insert, and PNG export shapes', () => {
    const extract = { path: '/tmp/test.pdf', pages: [0, 2], suggestedName: 'pages.pdf' }
    const insert = { path: '/tmp/test.pdf', afterPageIndex: -1 }
    const exportRequest = {
      images: [pngSignature],
      pageNumbers: [1],
      baseName: 'page',
    }
    expect(parseExtractPagesRequest(extract)).toEqual(extract)
    expect(parseInsertPdfRequest(insert)).toEqual(insert)
    expect(parseExportImagesRequest(exportRequest)).toEqual(exportRequest)
  })

  it('drops unknown binary fields before auxiliary requests reach main IPC', () => {
    expect(
      parseExtractPagesRequest({
        path: '/tmp/test.pdf',
        pages: [0],
        suggestedName: 'pages.pdf',
        hidden: new Uint8Array(1024),
      }),
    ).not.toHaveProperty('hidden')
    expect(
      parseInsertPdfRequest({
        path: '/tmp/test.pdf',
        afterPageIndex: -1,
        hidden: new Uint8Array(1024),
      }),
    ).not.toHaveProperty('hidden')
    expect(
      parseExportImagesRequest({
        images: [pngSignature],
        pageNumbers: [1],
        baseName: 'page',
        hidden: new Uint8Array(1024),
      }),
    ).not.toHaveProperty('hidden')
  })

  it('rejects path-like names, duplicate pages, and non-PNG export payloads', () => {
    expect(() =>
      parseExtractPagesRequest({
        path: '/tmp/test.pdf',
        pages: [0],
        suggestedName: '../outside.pdf',
      }),
    ).toThrow('suggestedName filename')
    expect(() =>
      parseExtractPagesRequest({
        path: '/tmp/test.pdf',
        pages: [1, 1],
        suggestedName: 'pages.pdf',
      }),
    ).toThrow('duplicate extract page')
    expect(() =>
      parseExportImagesRequest({ images: ['YWJj'], pageNumbers: [1], baseName: 'page' }),
    ).toThrow('export image PNG')
    expect(() =>
      parseExportImagesRequest({
        images: [pngSignature, pngSignature],
        pageNumbers: [1],
        baseName: 'page',
      }),
    ).toThrow('export page numbers')
  })
})
