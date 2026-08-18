import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { docxToText } from './docx'
import { pdfToText } from './pdf'
import { pptxToText } from './pptx'
import { xlsxToText } from './xlsx'
import { assertParseInputSize, assertSafeText } from './limits'

export type ParsedFileKind = 'text' | 'image' | 'unsupported'

export interface ParsedFile {
  ok: boolean
  text?: string
  kind: ParsedFileKind
  mime?: string
  error?: string
}

/** No text extraction for images: callers read raw bytes and go multimodal (see @genoffice/ai-provider images support) */
const IMAGE_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

const TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'xml',
  'html',
  'htm',
  'log',
])

/** parse an attachment into plain text (or flag it as image / unsupported) */
export async function parseFileToText(filePath: string): Promise<ParsedFile> {
  const ext = extname(filePath).slice(1).toLowerCase()
  const imageMime = IMAGE_MIMES[ext]
  if (imageMime) return { ok: true, kind: 'image', mime: imageMime }
  if (!TEXT_EXTS.has(ext) && !['docx', 'pptx', 'xlsx', 'pdf'].includes(ext)) {
    return { ok: false, kind: 'unsupported', error: `Unsupported file type: .${ext || 'unknown'}` }
  }
  try {
    const before = await stat(filePath)
    assertParseInputSize(before.size)
    const bytes = await readFile(filePath)
    // Recheck after the read so a file that grows between stat and read still
    // fails closed instead of bypassing the input budget.
    assertParseInputSize(bytes.byteLength)

    let text: string
    if (TEXT_EXTS.has(ext)) {
      text = bytes.toString('utf8')
      assertSafeText(text)
      return { ok: true, kind: 'text', text }
    }
    switch (ext) {
      case 'docx':
        text = await docxToText(bytes)
        break
      case 'pptx':
        text = await pptxToText(bytes)
        break
      case 'xlsx':
        text = await xlsxToText(bytes)
        break
      case 'pdf':
        text = await pdfToText(bytes)
        break
      default:
        throw new Error('Unsupported parser state')
    }
    assertSafeText(text)
    return { ok: true, kind: 'text', text }
  } catch (e) {
    return { ok: false, kind: 'text', error: e instanceof Error ? e.message : String(e) }
  }
}
