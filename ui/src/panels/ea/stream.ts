import type { EaChatEvent } from '@seti/shared'

const EVENT_TYPES = new Set<EaChatEvent['type']>(['text', 'tool', 'tool_result', 'done', 'error'])

const isEventType = (value: string): value is EaChatEvent['type'] => (EVENT_TYPES as Set<string>).has(value)

/** One server-sent event block, or null for comments, pings and events this page does not know. */
export function parseEvent(block: string): EaChatEvent | null {
  let type = ''
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      type = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart())
    }
  }
  if (!isEventType(type) || data.length === 0) {
    return null
  }
  try {
    const payload = JSON.parse(data.join('\n')) as object
    return { ...payload, type } as EaChatEvent
  } catch {
    return null
  }
}

/** The chat events of a streamed reply, as each block arrives. */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<EaChatEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n')
      let end = buffer.indexOf('\n\n')
      while (end >= 0) {
        const event = parseEvent(buffer.slice(0, end))
        buffer = buffer.slice(end + 2)
        if (event !== null) {
          yield event
        }
        end = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}
