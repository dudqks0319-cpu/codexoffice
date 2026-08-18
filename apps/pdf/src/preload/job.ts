import { ipcRenderer } from 'electron'

import { applySaveRequest, extractPagesBytes, insertPdfBytes } from '../main/pdf-transform'
import { PDF_JOB_CHANNELS } from '../shared/job'
import type { PdfJobDispatchEnvelope } from '../shared/job'
import {
  PDF_MAX_EDIT_SOURCE_BYTES,
  PDF_MAX_JOB_INPUT_BYTES,
  PDF_MAX_JOB_OUTPUT_BYTES,
  PDF_MAX_JOB_REQUEST_BYTES,
} from '../shared/limits'

const boundedJsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength

async function fetchPdf(url: string, maximumBytes: number): Promise<Uint8Array> {
  const response = await fetch(url, { cache: 'no-store', credentials: 'omit' })
  if (!response.ok || !response.body) throw new Error('invalid input')
  const declaredHeader = response.headers.get('content-length')
  const declared = Number(declaredHeader)
  if (
    declaredHeader === null ||
    !Number.isSafeInteger(declared) ||
    declared <= 0 ||
    declared > maximumBytes
  ) {
    throw new Error('input limit')
  }
  const reader = response.body.getReader()
  const output = new Uint8Array(declared)
  let total = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!(value instanceof Uint8Array) || value.byteLength === 0) continue
      if (total + value.byteLength > declared) throw new Error('input limit')
      output.set(value, total)
      total += value.byteLength
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  if (total !== declared) throw new Error('invalid input')
  return output
}

ipcRenderer.once(PDF_JOB_CHANNELS.run, async (_event, raw: unknown) => {
  if (typeof raw !== 'object' || raw === null) return
  const envelope = raw as Partial<PdfJobDispatchEnvelope>
  if (
    typeof envelope.id !== 'string' ||
    typeof envelope.token !== 'string' ||
    !Number.isFinite(envelope.deadlineAt) ||
    typeof envelope.outputUrl !== 'string'
  ) {
    return
  }
  try {
    if (Date.now() > (envelope.deadlineAt as number)) throw new Error('expired')
    const job = envelope.job
    if (!job || !['save', 'extract', 'insert'].includes(job.kind)) throw new Error('invalid job')
    if (job.kind === 'save' && boundedJsonBytes(job.request) > PDF_MAX_JOB_REQUEST_BYTES) {
      throw new Error('request limit')
    }
    const bytes = await fetchPdf(job.sourceUrl, PDF_MAX_EDIT_SOURCE_BYTES)
    let output: Uint8Array
    let insertedCount: number | undefined
    if (job.kind === 'save') {
      output = await applySaveRequest(bytes, job.request)
    } else if (job.kind === 'extract') {
      output = await extractPagesBytes(bytes, job.pages)
    } else {
      const otherBytes = await fetchPdf(
        job.otherUrl,
        Math.min(PDF_MAX_EDIT_SOURCE_BYTES, PDF_MAX_JOB_INPUT_BYTES - bytes.byteLength),
      )
      const inserted = await insertPdfBytes(bytes, otherBytes, job.afterPageIndex)
      output = inserted.merged
      insertedCount = inserted.count
    }
    if (
      Date.now() > (envelope.deadlineAt as number) ||
      output.byteLength === 0 ||
      output.byteLength > PDF_MAX_JOB_OUTPUT_BYTES
    ) {
      throw new Error('output limit')
    }
    const uploaded = await fetch(envelope.outputUrl, {
      method: 'POST',
      body: new Blob([new Uint8Array(output)], { type: 'application/pdf' }),
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        'content-type': 'application/pdf',
        'x-genoffice-job-id': envelope.id,
        'x-genoffice-job-token': envelope.token,
        'x-genoffice-job-status': 'ok',
        'x-genoffice-output-bytes': String(output.byteLength),
        ...(insertedCount === undefined
          ? {}
          : { 'x-genoffice-inserted-count': String(insertedCount) }),
      },
    })
    if (!uploaded.ok) throw new Error('output rejected')
  } catch {
    await fetch(envelope.outputUrl, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        'x-genoffice-job-id': envelope.id,
        'x-genoffice-job-token': envelope.token,
        'x-genoffice-job-status': 'transform-failed',
      },
    }).catch(() => undefined)
  }
})
