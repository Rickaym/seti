import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { InProcessClient, type SdkServer } from './fake-mcp.js'

/** The line every fake dream adds to the agent's MEMORY.md, with a path too long for a phone. */
export const DREAM_LINE =
  '- The user wants short replies, as in notes/replies/short-answers-for-every-channel-and-every-reviewer.md'
/** The leftover a fake dream proposes to trash when clean-ups are on. */
export const LEFTOVER = 'old-notes.md'
/** The summary every fake dream reports. */
export const DREAM_SUMMARY = 'Kept one rule about replies'

interface UserMessage {
  message: { content: string | { type: string; text?: string }[] }
}

type Hook = (input: object, id: string, options: { signal: AbortSignal }) => Promise<unknown>

interface DreamOptions {
  cwd?: string
  mcpServers?: Record<string, SdkServer>
  hooks?: { PreToolUse?: { hooks: Hook[] }[] }
}

const textOf = (m: UserMessage) =>
  typeof m.message.content === 'string'
    ? m.message.content
    : m.message.content.map((block) => block.text ?? '').join('')

/** Whether Seti's PreToolUse gate lets this call run. */
async function allowed(options: DreamOptions, tool: string, input: object): Promise<boolean> {
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0]
  const answer = (await hook?.(
    { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: randomUUID() },
    'call',
    { signal: new AbortController().signal },
  )) as { hookSpecificOutput?: { permissionDecision?: string } } | undefined
  return answer?.hookSpecificOutput?.permissionDecision === 'allow'
}

/**
 * The fake's dream: adds one line to MEMORY.md in the memory folder its message names, when the
 * gate allows the write, reports through the dream server, and ends with a cost.
 */
async function* dream(prompt: AsyncIterable<UserMessage>, options: DreamOptions): AsyncGenerator<object> {
  const session = randomUUID()
  const sdk = (m: object) => ({ session_id: session, uuid: randomUUID(), parent_tool_use_id: null, ...m })
  for await (const m of prompt) {
    const memory = /Memory folder: (\S+)\./.exec(textOf(m))?.[1] ?? ''
    const file = path.join(memory, 'MEMORY.md')
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    const content = `${before}${DREAM_LINE}\n`
    if (await allowed(options, 'Write', { file_path: file, content })) {
      fs.mkdirSync(memory, { recursive: true })
      fs.writeFileSync(file, content)
    }
    const server = options.mcpServers?.dream?.instance
    const client = server === undefined ? null : new InProcessClient(server)
    if (client !== null && textOf(m).includes('dream_propose') && options.cwd !== undefined) {
      const target = path.join(options.cwd, LEFTOVER)
      await client.call('dream_propose', { kind: 'trash', target, reason: 'Stale notes' })
    }
    if (client !== null) {
      await client.call('dream_report', {
        summary: DREAM_SUMMARY,
        tidied: ['MEMORY.md: one rule'],
      })
    }
    yield sdk({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.05, errors: [] })
  }
}

/** The Agent SDK's query for a dream, with the controls Seti calls on it. */
export const dreamQuery = (prompt: AsyncIterable<UserMessage>, options: DreamOptions) =>
  Object.assign(dream(prompt, options), {
    interrupt: async () => Promise.resolve(),
    close: () => undefined,
  })
