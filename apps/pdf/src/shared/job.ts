import type { SavePdfRequest } from './ipc'

export const PDF_JOB_CHANNELS = {
  run: 'pdf-job:run',
} as const

export const PDF_JOB_SCHEME = 'genoffice-pdf-job'

export interface PdfJobFileSource {
  /** Trusted main-process path. It is staged before the sandbox receives an opaque URL. */
  readonly path: string
  readonly byteLength: number
  readonly sha256: string
}

export type PdfTransformJob =
  | { readonly kind: 'save'; readonly source: PdfJobFileSource; readonly request: SavePdfRequest }
  | { readonly kind: 'extract'; readonly source: PdfJobFileSource; readonly pages: number[] }
  | {
      readonly kind: 'insert'
      readonly source: PdfJobFileSource
      readonly other: PdfJobFileSource
      readonly afterPageIndex: number
    }

export type PdfDispatchedTransformJob =
  | { readonly kind: 'save'; readonly sourceUrl: string; readonly request: SavePdfRequest }
  | { readonly kind: 'extract'; readonly sourceUrl: string; readonly pages: number[] }
  | {
      readonly kind: 'insert'
      readonly sourceUrl: string
      readonly otherUrl: string
      readonly afterPageIndex: number
    }

export interface PdfJobEnvelope {
  readonly id: string
  readonly token: string
  readonly deadlineAt: number
  readonly job: PdfTransformJob
}

export interface PdfJobDispatchEnvelope extends Omit<PdfJobEnvelope, 'job'> {
  readonly job: PdfDispatchedTransformJob
  readonly outputUrl: string
}

export type PdfJobReply =
  | {
      readonly id: string
      readonly token: string
      readonly ok: true
      /** Filled only after the authenticated chunk stream has been assembled by main. */
      readonly bytes?: Uint8Array
      readonly byteLength: number
      readonly chunkCount: number
      readonly insertedCount?: number
    }
  | {
      readonly id: string
      readonly token: string
      readonly ok: false
      readonly error: 'transform-failed'
    }

export interface PdfJobChunk {
  readonly id: string
  readonly token: string
  readonly type: 'chunk'
  readonly index: number
  readonly bytes: Uint8Array
}

export interface PdfJobChunkAck {
  readonly id: string
  readonly token: string
  readonly ack: number
}

export interface PdfTransformResult {
  readonly bytes: Uint8Array
  readonly insertedCount?: number
}

export function pdfJobInputByteLength(job: PdfTransformJob): {
  readonly binaryBytes: number
  readonly requestBytes: number
  readonly totalBytes: number
} {
  const binaryBytes = job.source.byteLength + (job.kind === 'insert' ? job.other.byteLength : 0)
  const requestBytes =
    job.kind === 'save' ? new TextEncoder().encode(JSON.stringify(job.request)).byteLength : 0
  return { binaryBytes, requestBytes, totalBytes: binaryBytes + requestBytes }
}
