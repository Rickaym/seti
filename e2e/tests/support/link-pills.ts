import { randomUUID } from 'node:crypto'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

const SESSION = 'link-pills-session'

/** The links the seeded transcript holds, and the label each pill shows. */
export const LINKS = {
  slack: { url: 'https://acme.slack.com/archives/C08ABCDEF12/p1731000000123456', label: 'Slack message' },
  pr: { url: 'https://github.com/acme/widgets/pull/123', label: 'acme/widgets#123' },
  plain: { url: 'https://example.com/docs/setup', label: 'example.com/docs/setup' },
  /** Its label starts with the host and first folder, then cuts the rest short. */
  long: {
    url: `https://example.com/reports/${'quarterly-numbers-'.repeat(12)}final.html?${'filter=all&'.repeat(10)}page=1`,
    label: 'example.com/reports/',
  },
  issue: { url: 'https://linear.app/acme/issue/ENG-42/fix-login', label: 'ENG-42' },
  code: 'https://example.com/in-code',
  labelled: 'https://example.com/changelog',
} as const

/** The agent's reply, as the agent wrote it, with each pill's link alone on its line. */
const REPLY = [
  `I read the thread and opened the fix:\n${LINKS.slack.url}\n${LINKS.pr.url}`,
  `Setup steps are in:\n${LINKS.plain.url}`,
  `- ${LINKS.issue.url}`,
  `See [the changelog](${LINKS.labelled}) for the release note, and \`${LINKS.code}\` for the endpoint.`,
  `The full report:\n${LINKS.long.url}`,
  `\`\`\`\ncurl ${LINKS.code}\n\`\`\``,
].join('\n\n')

/** What the user asked, with a link of its own. */
const PROMPT = `Summarise the discussion in ${LINKS.slack.url} and fix it.`

const assistant = (content: unknown[]) => ({
  type: 'assistant',
  message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'claude', content },
  parent_tool_use_id: null,
  session_id: SESSION,
  uuid: randomUUID(),
})

/** An idle agent whose prompt and reply are the ones given. */
export async function seedReply(title: string, reply: string, prompt = PROMPT): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const start = Date.now() - 5 * 60_000
  await db.idleTask(id, title, paths.checkout, new Date(start).toISOString())
  const rows = [
    { kind: 'prompt', payload: { text: prompt } },
    { kind: 'sdk', payload: assistant([{ type: 'text', text: reply }]) },
    {
      kind: 'sdk',
      payload: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: reply,
        duration_ms: 4000,
        num_turns: 1,
        total_cost_usd: 0,
        session_id: SESSION,
        uuid: randomUUID(),
      },
    },
  ]
  let at = start
  for (const row of rows) {
    at += 1500
    await db.message(id, row.kind, JSON.stringify(row.payload), new Date(at).toISOString())
  }
  await db.close()
  return id
}

/** An idle agent whose prompt and reply hold Slack, GitHub, Linear, plain and very long links. */
export const seedLinkPills = async (title: string): Promise<string> => seedReply(title, REPLY)
