import { parentPort } from 'node:worker_threads'
import { inspectPptxDesign } from '@genoffice/pptx-engine'

interface InspectMessage {
  bytes: ArrayBuffer
  sourceName: string
  deadlineMs: number
}

parentPort?.once('message', async (message: InspectMessage) => {
  try {
    const inspection = await inspectPptxDesign(new Uint8Array(message.bytes), {
      sourceName: message.sourceName,
      deadlineMs: message.deadlineMs,
    })
    parentPort?.postMessage({ ok: true, inspection })
  } catch {
    // The worker is an untrusted-file boundary: never send raw parser errors or paths back.
    parentPort?.postMessage({ ok: false })
  }
})
