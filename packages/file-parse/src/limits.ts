import type JSZip from 'jszip'

export const PARSE_MAX_INPUT_BYTES = 50 * 1024 * 1024
export const PARSE_MAX_ARCHIVE_ENTRIES = 10_000
export const PARSE_MAX_ARCHIVE_EXPANDED_BYTES = 512 * 1024 * 1024
export const PARSE_MAX_ARCHIVE_PART_BYTES = 64 * 1024 * 1024
export const PARSE_MAX_TEXT_BYTES = 2 * 1024 * 1024
export const PARSE_MAX_PDF_PAGES = 2_000

const encoder = new TextEncoder()

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024)
}

/** Reject oversized files before any parser or archive inflater sees them. */
export function assertParseInputSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > PARSE_MAX_INPUT_BYTES) {
    throw new Error(`Attachment exceeds the ${mb(PARSE_MAX_INPUT_BYTES)} MB parsing limit`)
  }
}

type SizedZipEntry = {
  dir?: boolean
  _data?: { uncompressedSize?: number }
}

/**
 * Inspect ZIP central-directory metadata before inflating OOXML parts. JSZip
 * sanitizes relative paths too, but fail closed here so callers never depend on
 * that implementation detail for untrusted attachments.
 */
export function assertSafeArchive(zip: JSZip, kind: string): void {
  const entries = Object.entries(zip.files)
  if (entries.length > PARSE_MAX_ARCHIVE_ENTRIES) {
    throw new Error(`${kind}: archive contains too many entries`)
  }

  let expandedBytes = 0
  for (const [name, rawEntry] of entries) {
    const entry = rawEntry as SizedZipEntry
    const normalized = name.replaceAll('\\', '/')
    if (name.includes('\0') || normalized.split('/').includes('..')) {
      throw new Error(`${kind}: archive contains an unsafe path`)
    }
    if (entry.dir) continue

    const size = entry._data?.uncompressedSize
    if (!Number.isSafeInteger(size) || size === undefined || size < 0) {
      throw new Error(`${kind}: archive entry size is invalid`)
    }
    if (size > PARSE_MAX_ARCHIVE_PART_BYTES) {
      throw new Error(`${kind}: archive part exceeds the parsing limit`)
    }
    expandedBytes += size
    if (expandedBytes > PARSE_MAX_ARCHIVE_EXPANDED_BYTES) {
      throw new Error(`${kind}: expanded archive exceeds the parsing limit`)
    }
  }
}

/** Inflate one known OOXML text part while checking both declared and actual size. */
export async function readSafeZipText(
  zip: JSZip,
  path: string,
  kind: string,
): Promise<string | undefined> {
  const file = zip.file(path)
  if (!file) return undefined
  const declared = (file as SizedZipEntry)._data?.uncompressedSize
  if (!Number.isSafeInteger(declared) || declared === undefined || declared < 0) {
    throw new Error(`${kind}: archive entry size is invalid`)
  }
  if (declared > PARSE_MAX_ARCHIVE_PART_BYTES) {
    throw new Error(`${kind}: archive part exceeds the parsing limit`)
  }
  const text = await file.async('text')
  if (encoder.encode(text).byteLength > PARSE_MAX_ARCHIVE_PART_BYTES) {
    throw new Error(`${kind}: archive part exceeds the parsing limit`)
  }
  return text
}

/** Tracks generated plain text so parsing cannot build an unbounded AI prompt. */
export class TextBudget {
  #bytes = 0

  add(text: string, separator = ''): void {
    this.#bytes += encoder.encode(separator).byteLength + encoder.encode(text).byteLength
    if (this.#bytes > PARSE_MAX_TEXT_BYTES) {
      throw new Error(`Extracted text exceeds the ${mb(PARSE_MAX_TEXT_BYTES)} MB parsing limit`)
    }
  }
}

export function assertSafeText(text: string): void {
  if (encoder.encode(text).byteLength > PARSE_MAX_TEXT_BYTES) {
    throw new Error(`Extracted text exceeds the ${mb(PARSE_MAX_TEXT_BYTES)} MB parsing limit`)
  }
}

export function assertPdfPageCount(pageCount: number): void {
  if (!Number.isSafeInteger(pageCount) || pageCount < 0 || pageCount > PARSE_MAX_PDF_PAGES) {
    throw new Error(`PDF contains more than ${PARSE_MAX_PDF_PAGES.toLocaleString('en-US')} pages`)
  }
}
