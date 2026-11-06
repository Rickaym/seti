import { setTimeout as sleep } from 'node:timers/promises'
import type { EaChatEvent } from '@seti/shared'
import { claimSend, finishSend, releaseSend, type SendKey } from './client-sends.js'

/** What a repeat of a typed EA message answers: the stored entries of the first one's reply. */
interface ChatResult {
  ids: number[]
}

const POLL_MS = 250
const PING_MS = 10_000
/** A reply that streams longer than this is not waited for; the repeat says to send again. */
const REPEAT_WAIT_MS = 3 * 60_000
const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }

const encoder = new TextEncoder()
const PING = encoder.encode(': ping\n\n')

const sse = (event: EaChatEvent) => {
  const { type, ...data } = event
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
}

const isIds = (value: unknown): value is number[] => Array.isArray(value) && value.every((id) => typeof id === 'number')

/** The ids of a `done` event block, or null for any other block. */
function doneIds(block: string): number[] | null {
  const lines = block.split('\n')
  if (!lines.some((line) => line.trim() === 'event: done')) {
    return null
  }
  const data = lines.find((line) => line.startsWith('data:'))?.slice(5)
  try {
    const parsed: unknown = JSON.parse(data ?? '')
    const ids: unknown = typeof parsed === 'object' && parsed !== null && 'ids' in parsed ? parsed.ids : null
    return isIds(ids) ? ids : null
  } catch {
    return null
  }
}

interface Sink {
  push: (chunk: Uint8Array) => void
  close: () => void
  fail: (e: unknown) => void
}

/** Reads the EA's reply to its end even if the client left, then records or releases the send. */
async function pump(source: ReadableStream<Uint8Array>, key: SendKey, sink: Sink): Promise<void> {
  const reader = source.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let ids: number[] | null = null
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      sink.push(chunk.value)
      buffer += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n')
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() ?? ''
      ids = blocks.map(doneIds).findLast((found) => found !== null) ?? ids
    }
    sink.close()
  } catch (e) {
    sink.fail(e)
  }
  await (ids === null ? releaseSend(key) : finishSend(key, { ids } satisfies ChatResult))
}

/** Relays the reply as it streams and keeps its outcome for repeats of the same send. */
export function recordChatReply(res: Response, key: SendKey): Response {
  const source = res.body
  if (source === null) {
    void releaseSend(key)
    return res
  }
  let open = true
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sink: Sink = {
        push: (chunk) => {
          if (open) {
            controller.enqueue(chunk)
          }
        },
        close: () => {
          if (open) {
            open = false
            controller.close()
          }
        },
        fail: (e) => {
          if (open) {
            open = false
            controller.error(e)
          }
        },
      }
      void pump(source, key, sink).catch(() => undefined)
    },
    cancel() {
      open = false
    },
  })
  return new Response(stream, { status: res.status, headers: res.headers })
}

/** The first send's outcome once it is known, polled while its reply still streams. */
async function firstOutcome(key: SendKey, ping: () => void): Promise<EaChatEvent> {
  const deadline = Date.now() + REPEAT_WAIT_MS
  let pinged = Date.now()
  while (Date.now() < deadline) {
    const claim = await claimSend<ChatResult>(key)
    if (claim.state === 'done') {
      return { type: 'done', ids: claim.result.ids }
    }
    if (claim.state === 'run') {
      await releaseSend(key)
      break
    }
    if (Date.now() - pinged >= PING_MS) {
      pinged = Date.now()
      ping()
    }
    await sleep(POLL_MS)
  }
  return { type: 'error', title: 'The EA could not answer', detail: 'That message did not finish; send it again.' }
}

/** Answers a repeat of a typed message with the first one's outcome, and sends nothing to the EA. */
export function repeatedChat(key: SendKey): Response {
  let open = true
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const ping = () => {
        if (open) {
          controller.enqueue(PING)
        }
      }
      ping()
      void firstOutcome(key, ping).then((outcome) => {
        if (open) {
          controller.enqueue(sse(outcome))
          controller.close()
        }
      })
    },
    cancel() {
      open = false
    },
  })
  return new Response(stream, { status: 200, headers: SSE_HEADERS })
}
