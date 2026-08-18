import type {
  ExportImagesRequest,
  ExtractPagesRequest,
  InsertPdfRequest,
  SavePdfRequest,
} from '../shared/ipc'

/** Keep standalone so both sandboxed preloads bundle into one file; mirrors shared/limits.ts. */
export const PDF_EDIT_MAX_PAGES = 20_000

const MAX_MARKUPS = 50_000
const MAX_QUADS = 200_000
const MAX_DRAWINGS = 20_000
const MAX_INK_COORDINATES = 1_000_000
const MAX_STAMPS = 2_000
const MAX_STAMP_BASE64 = 14 * 1024 * 1024
const MAX_TOTAL_STAMP_BASE64 = 20 * 1024 * 1024
const MAX_FORM_VALUES = 10_000
const MAX_FORM_TEXT = 1024 * 1024
const MAX_TOTAL_FORM_TEXT = 4 * 1024 * 1024
const MAX_METADATA_TEXT = 64 * 1024
const MAX_PATH_LENGTH = 4096
const MAX_COORDINATE = 10_000_000
const MAX_EXPORT_IMAGE_BASE64 = 32 * 1024 * 1024
const MAX_TOTAL_EXPORT_BASE64 = 256 * 1024 * 1024

const fail = (message: string): never => {
  throw new Error(`pdf: invalid save request (${message})`)
}

const object = (value: unknown, name: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${name} object`)
  return value as Record<string, unknown>
}

const string = (value: unknown, name: string, max: number, allowEmpty = true): string => {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0)) {
    fail(`${name} string`)
  }
  return value as string
}

const finite = (value: unknown, name: string, min = -MAX_COORDINATE, max = MAX_COORDINATE) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`${name} number`)
  }
  return value as number
}

const integer = (value: unknown, name: string, max = PDF_EDIT_MAX_PAGES - 1) => {
  const parsed = finite(value, name, 0, max)
  if (!Number.isInteger(parsed)) fail(`${name} integer`)
  return parsed
}

const tuple = (value: unknown, name: string, length: number): number[] => {
  if (!Array.isArray(value) || value.length !== length) fail(`${name} tuple`)
  return (value as unknown[]).map((entry, index) => finite(entry, `${name}[${index}]`))
}

function parseColor(value: unknown, name: string): [number, number, number] {
  const color = tuple(value, name, 3).map((channel) => finite(channel, name, 0, 1))
  return color as [number, number, number]
}

function parseMarkup(value: unknown, budget: { quads: number }): SavePdfRequest['markups'][number] {
  const markup = object(value, 'markup')
  const pageIndex = integer(markup.pageIndex, 'markup.pageIndex')
  if (!['highlight', 'underline', 'strikeout'].includes(String(markup.type))) {
    fail('markup.type')
  }
  const color = parseColor(markup.color, 'markup.color')
  if (!Array.isArray(markup.quads) || markup.quads.length === 0) fail('markup.quads')
  const quads = markup.quads as unknown[]
  budget.quads += quads.length
  if (budget.quads > MAX_QUADS) fail('too many markup quads')
  return {
    pageIndex,
    type: markup.type as SavePdfRequest['markups'][number]['type'],
    color,
    quads: quads.map((quad) => tuple(quad, 'markup.quad', 8)),
  }
}

function parseDrawing(
  value: unknown,
  budget: { inkCoordinates: number },
): SavePdfRequest['drawings'][number] {
  const drawing = object(value, 'drawing')
  const kind = String(drawing.kind)
  if (!['ink', 'rect', 'ellipse', 'line', 'arrow', 'note'].includes(kind)) fail('drawing.kind')
  const pageIndex = integer(drawing.pageIndex, 'drawing.pageIndex')
  const color = parseColor(drawing.color, 'drawing.color')
  if (kind === 'note') {
    return {
      kind,
      pageIndex,
      color,
      at: tuple(drawing.at, 'drawing.at', 2) as [number, number],
      contents: string(drawing.contents, 'drawing.contents', 64 * 1024),
    }
  }
  const width = finite(drawing.width, 'drawing.width', 0.1, 100)
  if (kind === 'ink') {
    if (!Array.isArray(drawing.paths) || drawing.paths.length === 0) fail('drawing.paths')
    const paths = (drawing.paths as unknown[]).map((path) => {
      if (!Array.isArray(path) || path.length < 4 || path.length % 2 !== 0) fail('drawing.path')
      const coordinates = path as unknown[]
      budget.inkCoordinates += coordinates.length
      if (budget.inkCoordinates > MAX_INK_COORDINATES) fail('too many ink coordinates')
      return coordinates.map((coordinate) => finite(coordinate, 'drawing.path coordinate'))
    })
    return { kind, pageIndex, color, width, paths }
  }
  if (kind === 'rect' || kind === 'ellipse') {
    return {
      kind,
      pageIndex,
      color,
      width,
      rect: tuple(drawing.rect, 'drawing.rect', 4) as [number, number, number, number],
    }
  }
  return {
    kind: kind as 'line' | 'arrow',
    pageIndex,
    color,
    width,
    from: tuple(drawing.from, 'drawing.from', 2) as [number, number],
    to: tuple(drawing.to, 'drawing.to', 2) as [number, number],
  }
}

function parseStamp(
  value: unknown,
  budget: { encodedBytes: number },
): SavePdfRequest['stamps'][number] {
  const stamp = object(value, 'stamp')
  const pageIndex = integer(stamp.pageIndex, 'stamp.pageIndex')
  const image = string(stamp.image, 'stamp.image', MAX_STAMP_BASE64, false)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image)) fail('stamp.image base64')
  budget.encodedBytes += image.length
  if (budget.encodedBytes > MAX_TOTAL_STAMP_BASE64) fail('total stamp data')
  return {
    pageIndex,
    image,
    rect: tuple(stamp.rect, 'stamp.rect', 4) as [number, number, number, number],
    ...(stamp.opacity === undefined
      ? {}
      : { opacity: finite(stamp.opacity, 'stamp.opacity', 0, 1) }),
  }
}

/** Main-process trust boundary for renderer-provided PDF mutation payloads. */
export function parseSavePdfRequest(value: unknown): SavePdfRequest {
  const request = object(value, 'request')
  string(request.path, 'path', MAX_PATH_LENGTH, false)
  if (request.targetPath !== undefined)
    string(request.targetPath, 'targetPath', MAX_PATH_LENGTH, false)
  if (request.auto !== undefined && typeof request.auto !== 'boolean') fail('auto boolean')

  if (!Array.isArray(request.markups) || request.markups.length > MAX_MARKUPS) {
    fail('markups limit')
  }
  const markupBudget = { quads: 0 }
  const markups = (request.markups as unknown[]).map((markup) => parseMarkup(markup, markupBudget))

  if (!Array.isArray(request.drawings) || request.drawings.length > MAX_DRAWINGS) {
    fail('drawings limit')
  }
  const drawingBudget = { inkCoordinates: 0 }
  const drawings = (request.drawings as unknown[]).map((drawing) =>
    parseDrawing(drawing, drawingBudget),
  )

  if (!Array.isArray(request.stamps) || request.stamps.length > MAX_STAMPS) fail('stamps limit')
  const stampBudget = { encodedBytes: 0 }
  const stamps = (request.stamps as unknown[]).map((stamp) => parseStamp(stamp, stampBudget))

  if (!Array.isArray(request.formValues) || request.formValues.length > MAX_FORM_VALUES) {
    fail('form values limit')
  }
  let formText = 0
  const formValues = (request.formValues as unknown[]).map((raw) => {
    const form = object(raw, 'form value')
    const name = string(form.name, 'form name', 1024, false)
    if (!['text', 'checkbox', 'radio', 'choice'].includes(String(form.kind))) fail('form kind')
    const kind = form.kind as SavePdfRequest['formValues'][number]['kind']
    let valueText: string | undefined
    if (form.value !== undefined) {
      valueText = string(form.value, 'form value', MAX_FORM_TEXT)
      formText += valueText.length
      if (formText > MAX_TOTAL_FORM_TEXT) fail('total form text')
    }
    if (form.checked !== undefined && typeof form.checked !== 'boolean') fail('form checked')
    return {
      name,
      kind,
      ...(valueText === undefined ? {} : { value: valueText }),
      ...(form.checked === undefined ? {} : { checked: form.checked as boolean }),
    }
  })

  for (const [name, raw, max] of [
    ['rotations', request.rotations, PDF_EDIT_MAX_PAGES],
    ['deletedPages', request.deletedPages, PDF_EDIT_MAX_PAGES],
    ['pageOrder', request.pageOrder, PDF_EDIT_MAX_PAGES],
  ] as const) {
    if (raw === undefined) continue
    if (!Array.isArray(raw) || raw.length > max) fail(`${name} limit`)
  }
  const rotationPages = new Set<number>()
  const rotations = ((request.rotations ?? []) as unknown[]).map((rotation) => {
    const entry = object(rotation, 'rotation')
    const pageIndex = integer(entry.pageIndex, 'rotation.pageIndex')
    if (rotationPages.has(pageIndex)) fail('duplicate rotation page')
    rotationPages.add(pageIndex)
    const delta = finite(entry.delta, 'rotation.delta', -360, 360)
    if (!Number.isInteger(delta) || delta % 90 !== 0) fail('rotation.delta multiple of 90')
    return { pageIndex, delta }
  })
  const deletedSet = new Set<number>()
  const deletedPages = ((request.deletedPages ?? []) as unknown[]).map((page) => {
    const index = integer(page, 'deleted page')
    if (deletedSet.has(index)) fail('duplicate deleted page')
    deletedSet.add(index)
    return index
  })
  const orderSet = new Set<number>()
  const pageOrder = ((request.pageOrder ?? []) as unknown[]).map((page) => {
    const index = integer(page, 'page order')
    if (orderSet.has(index)) fail('duplicate page order')
    orderSet.add(index)
    return index
  })

  let metadata: SavePdfRequest['metadata'] | undefined
  if (request.metadata !== undefined) {
    const rawMetadata = object(request.metadata, 'metadata')
    metadata = Object.fromEntries(
      ['title', 'author', 'subject', 'keywords']
        .filter((key) => rawMetadata[key] !== undefined)
        .map((key) => [key, string(rawMetadata[key], `metadata.${key}`, MAX_METADATA_TEXT)]),
    ) as SavePdfRequest['metadata']
  }
  return {
    path: request.path as string,
    ...(request.targetPath === undefined ? {} : { targetPath: request.targetPath as string }),
    ...(request.auto === undefined ? {} : { auto: request.auto as boolean }),
    markups,
    drawings,
    formValues,
    stamps,
    ...(request.rotations === undefined ? {} : { rotations }),
    ...(request.deletedPages === undefined
      ? {}
      : {
          deletedPages,
        }),
    ...(request.pageOrder === undefined ? {} : { pageOrder }),
    ...(metadata === undefined ? {} : { metadata }),
  }
}

export function parseExtractPagesRequest(value: unknown): ExtractPagesRequest {
  const request = object(value, 'extract request')
  const path = string(request.path, 'path', MAX_PATH_LENGTH, false)
  if (
    !Array.isArray(request.pages) ||
    request.pages.length === 0 ||
    request.pages.length > PDF_EDIT_MAX_PAGES
  ) {
    fail('extract pages limit')
  }
  const seen = new Set<number>()
  const pages = (request.pages as unknown[]).map((page) => {
    const index = integer(page, 'extract page')
    if (seen.has(index)) fail('duplicate extract page')
    seen.add(index)
    return index
  })
  const suggestedName = string(request.suggestedName, 'suggestedName', 255, false)
  if (suggestedName.includes('/') || suggestedName.includes('\\') || suggestedName.includes('\0')) {
    fail('suggestedName filename')
  }
  return { path, pages, suggestedName }
}

export function parseInsertPdfRequest(value: unknown): InsertPdfRequest {
  const request = object(value, 'insert request')
  const path = string(request.path, 'path', MAX_PATH_LENGTH, false)
  const after = finite(request.afterPageIndex, 'afterPageIndex', -1, PDF_EDIT_MAX_PAGES - 1)
  if (!Number.isInteger(after)) fail('afterPageIndex integer')
  return { path, afterPageIndex: after }
}

export function parseExportImagesRequest(value: unknown): ExportImagesRequest {
  const request = object(value, 'export request')
  const rawImages = request.images
  const rawPageNumbers = request.pageNumbers
  if (
    !Array.isArray(rawImages) ||
    rawImages.length === 0 ||
    rawImages.length > PDF_EDIT_MAX_PAGES
  ) {
    fail('export images limit')
  }
  const rawImageList = rawImages as unknown[]
  if (!Array.isArray(rawPageNumbers) || rawPageNumbers.length !== rawImageList.length) {
    fail('export page numbers')
  }
  const numbers = rawPageNumbers as unknown[]
  let total = 0
  const images = rawImageList.map((image) => {
    const encoded = string(image, 'export image', MAX_EXPORT_IMAGE_BASE64, false)
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail('export image base64')
    total += encoded.length
    if (total > MAX_TOTAL_EXPORT_BASE64) fail('total export image data')
    const signature = Buffer.from(encoded.slice(0, 16), 'base64').subarray(0, 8).toString('hex')
    if (signature !== '89504e470d0a1a0a') fail('export image PNG')
    return encoded
  })
  const pageNumbers = new Set<number>()
  const normalizedPageNumbers = numbers.map((page) => {
    const number = finite(page, 'export page number', 1, PDF_EDIT_MAX_PAGES)
    if (!Number.isInteger(number)) fail('export page number integer')
    if (pageNumbers.has(number)) fail('duplicate export page number')
    pageNumbers.add(number)
    return number
  })
  const baseName = string(request.baseName, 'baseName', 255, false)
  return { images, pageNumbers: normalizedPageNumbers, baseName }
}
