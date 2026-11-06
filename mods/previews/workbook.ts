import type { ParsedSheet } from './grid'

type Reply = { sheets: ParsedSheet[] } | { error: string }

/** Reads a workbook in a worker of its own, ended once it answers or `signal` aborts. */
export async function parseWorkbook(data: ArrayBuffer, signal: AbortSignal): Promise<ParsedSheet[]> {
  const worker = new Worker(new URL('./sheet-worker.ts', import.meta.url), { type: 'module' })
  try {
    return await new Promise<ParsedSheet[]>((resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'))
      })
      worker.addEventListener('message', (event: MessageEvent<Reply>) => {
        const reply = event.data
        if ('error' in reply) {
          reject(new Error(reply.error))
        } else {
          resolve(reply.sheets)
        }
      })
      worker.addEventListener('error', (event) => {
        reject(new Error(event.message === '' ? 'The workbook reader failed' : event.message))
      })
      worker.postMessage(data, [data])
    })
  } finally {
    worker.terminate()
  }
}
