/** The JSON data of complete server-sent event blocks; the unfinished tail is returned to keep. */
function takeEvents(buffer: string): { events: unknown[]; rest: string } {
  const blocks = buffer.split('\n\n')
  const rest = blocks.pop() ?? ''
  const events = blocks.flatMap((block) => {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n')
    if (data === '') {
      return []
    }
    try {
      return [JSON.parse(data) as unknown]
    } catch {
      return []
    }
  })
  return { events, rest }
}

/** Reads server-sent events as they stream, handing over each one's JSON data in order. */
export async function readEvents(body: ReadableStream<Uint8Array>, onData: (data: unknown) => void): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    const text = done ? `${decoder.decode()}\n\n` : decoder.decode(value, { stream: true })
    const { events, rest } = takeEvents((buffer + text).replaceAll('\r\n', '\n'))
    buffer = rest
    events.forEach(onData)
    if (done) {
      return
    }
  }
}
