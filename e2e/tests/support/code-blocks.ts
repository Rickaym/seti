import { randomUUID } from 'node:crypto'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

const SESSION = 'code-session'

/** The code and tool output the seeded transcript shows. */
export const CODE = {
  typescript: "const answer: number = 42\nexport function ask(): string {\n  return 'why'\n}",
  untagged: '{"name": "seti", "private": true}',
  tool: 'mcp__clickup__clickup_get_task',
  output: '{"state":"OPEN","checks":[1,2],"title":"Ship it"}',
  outro: 'That is the task state.',
  summary: '- **state**: OPEN\n- **checks**: 2',
} as const

/** The reply holding both code blocks, as the agent wrote it. */
export const REPLY = `Here is the helper:\n\n\`\`\`ts\n${CODE.typescript}\n\`\`\`\n\nAnd the manifest:\n\n\`\`\`\n${CODE.untagged}\n\`\`\``

/** The turn's final reply, two text blocks after its last tool call, as the agent wrote it. */
export const TURN_REPLY = `${CODE.outro}\n\n${CODE.summary}`

const assistant = (content: unknown[]) => ({
  type: 'assistant',
  message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'claude', content },
  parent_tool_use_id: null,
  session_id: SESSION,
  uuid: randomUUID(),
})

/** An idle agent whose reply holds a tagged and an untagged code block, an MCP call and a reply. */
export async function seedCodeBlocks(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const start = Date.now() - 10 * 60_000
  await db.idleTask(id, title, paths.checkout, new Date(start).toISOString())
  const useId = 'toolu_code_mcp'
  const rows = [
    { kind: 'prompt', payload: { text: 'Show me the helper and the task.' } },
    { kind: 'sdk', payload: assistant([{ type: 'text', text: REPLY }]) },
    { kind: 'sdk', payload: assistant([{ type: 'tool_use', id: useId, name: CODE.tool, input: { task_id: '42' } }]) },
    {
      kind: 'sdk',
      payload: {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: CODE.output }] },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: randomUUID(),
      },
    },
    {
      kind: 'sdk',
      payload: assistant([
        { type: 'text', text: CODE.outro },
        { type: 'text', text: CODE.summary },
      ]),
    },
    {
      kind: 'sdk',
      payload: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: CODE.summary,
        duration_ms: 9000,
        num_turns: 2,
        total_cost_usd: 0,
        session_id: SESSION,
        uuid: randomUUID(),
      },
    },
  ]
  let at = start
  for (const row of rows) {
    at += 1700
    await db.message(id, row.kind, JSON.stringify(row.payload), new Date(at).toISOString())
  }
  await db.close()
  return id
}

/** A JavaScript array of about `chars` characters on one line, dense with tokens. */
function denseLine(chars: number, from = 0): string {
  const items: string[] = []
  let length = 0
  while (length < chars) {
    const item = `{id:${String(from + items.length)},on:true}`
    items.push(item)
    length += item.length + 1
  }
  return `const data = [${items.join(',')}]`
}

/** A code block of one line of about 45,000 characters, and one of many short lines. */
export const LONG_BLOCKS = {
  wide: denseLine(45_000),
  tall: Array.from({ length: 1_500 }, (_, n) => `const row${String(n)} = [${String(n)}, 'x', true]`).join('\n'),
} as const

/** An idle agent whose reply holds a block with one huge line and a block of many short lines. */
export async function seedLongCodeBlocks(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const start = Date.now() - 10 * 60_000
  await db.idleTask(id, title, paths.checkout, new Date(start).toISOString())
  const text = `The data:\n\n\`\`\`js\n${LONG_BLOCKS.wide}\n\`\`\`\n\nThe rows:\n\n\`\`\`js\n${LONG_BLOCKS.tall}\n\`\`\``
  const rows = [
    { kind: 'prompt', payload: { text: 'Show me the data.' } },
    { kind: 'sdk', payload: assistant([{ type: 'text', text }]) },
  ]
  let at = start
  for (const row of rows) {
    at += 1700
    await db.message(id, row.kind, JSON.stringify(row.payload), new Date(at).toISOString())
  }
  await db.close()
  return id
}
