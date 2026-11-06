import { randomUUID } from 'node:crypto'

/** What a side chat question asks the fake for to get a reply that streams for a few seconds. */
export const SLOW_QUESTION = 'take your time'
/** What every fake side chat answer starts with, in bold. */
export const SIDE_ANSWER = 'Side answer'
/** The file a fake side chat says it read when it may read files. */
export const SIDE_READ = 'README.md'

interface UserMessage {
  message: { content: string | { type: string; text?: string }[] }
}

interface SideOptions {
  resume?: string
  tools?: string[]
  abortController?: AbortController
}

const textOf = (m: UserMessage) =>
  typeof m.message.content === 'string'
    ? m.message.content
    : m.message.content.map((block) => block.text ?? '').join('')

/** The question itself, after the earlier exchanges a follow-up carries. */
const questionOf = (prompt: string) => prompt.split('New question:\n').at(-1)?.trim() ?? prompt

const pause = async (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })

/**
 * The fake's side chat: a fork of the agent's session that answers one question word by word,
 * after a read when it may read files, and never touches the agent's own fake session.
 */
async function* answer(prompt: AsyncIterable<UserMessage>, options: SideOptions): AsyncGenerator<object> {
  const session = randomUUID()
  const sdk = (m: object) => ({ session_id: session, uuid: randomUUID(), parent_tool_use_id: null, ...m })
  const signal = options.abortController?.signal
  for await (const m of prompt) {
    const question = questionOf(textOf(m))
    if (options.tools?.includes('Read') === true) {
      const input = { file_path: SIDE_READ }
      yield sdk({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_side', name: 'Read', input }] },
      })
    }
    const reply = `**${SIDE_ANSWER}** about ${question}, from session ${options.resume ?? 'none'}.`
    const words = reply.split(/(?<= )/)
    const delay = question.includes(SLOW_QUESTION) ? 400 : 20
    for (const word of words) {
      await pause(delay, signal)
      if (signal?.aborted === true) {
        return
      }
      const delta = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } }
      yield sdk({ type: 'stream_event', event: delta })
    }
    yield sdk({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } })
    yield sdk({ type: 'result', subtype: 'success', is_error: false, result: reply, total_cost_usd: 0.01, errors: [] })
  }
}

/** The Agent SDK's query for a side chat fork, with the controls Seti calls on it. */
export function sideChatQuery(prompt: AsyncIterable<UserMessage>, options: SideOptions) {
  const controller = new AbortController()
  options.abortController?.signal.addEventListener('abort', () => {
    controller.abort()
  })
  return Object.assign(answer(prompt, { ...options, abortController: controller }), {
    close: () => {
      controller.abort()
    },
  })
}
