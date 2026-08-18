import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { PptxDesignInspection } from '@genoffice/pptx-engine'

interface WorkerReply {
  ok: boolean
  inspection?: PptxDesignInspection
}

interface InspectionWorker {
  once(event: 'message', listener: (reply: WorkerReply) => void): this
  once(event: 'error', listener: () => void): this
  once(event: 'exit', listener: (code: number) => void): this
  postMessage(message: unknown, transferList: readonly ArrayBuffer[]): void
  terminate(): Promise<number>
}

type InspectionWorkerFactory = () => InspectionWorker

/** Run hostile PPTX inspection outside Electron main and terminate it at the hard deadline. */
export function inspectPptxDesignIsolated(
  bytes: Uint8Array,
  sourceName: string,
  timeoutMs = 10_000,
  createWorker: InspectionWorkerFactory = () =>
    new Worker(join(__dirname, 'design-inspect-worker.js')),
): Promise<PptxDesignInspection> {
  const worker = createWorker()
  const transferable = Uint8Array.from(bytes).buffer
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, inspection?: PptxDesignInspection) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      if (error) reject(error)
      else resolve(inspection!)
    }
    const timer = setTimeout(
      () => finish(new Error('pptx: design inspection timed out')),
      Math.max(1, timeoutMs),
    )
    worker.once('message', (reply: WorkerReply) => {
      if (!reply.ok || !reply.inspection) {
        finish(new Error('pptx: design inspection failed'))
        return
      }
      finish(undefined, reply.inspection)
    })
    worker.once('error', () => finish(new Error('pptx: design inspection failed')))
    worker.once('exit', (code) => {
      if (!settled && code !== 0) finish(new Error('pptx: design inspection failed'))
    })
    worker.postMessage({ bytes: transferable, sourceName, deadlineMs: timeoutMs }, [transferable])
  })
}
