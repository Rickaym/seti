import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

const SESSION = 'ledger-session'
const CHANNEL = 'C0LEDGER001'
const THREAD_TS = '1731000000.123456'

/** The links the reply cites: a thread the agent read, and a message it never saw. */
export const LEDGER = {
  read: `https://acme.slack.com/archives/${CHANNEL}/p1731000000123456`,
  unread: `https://acme.slack.com/archives/${CHANNEL}/p1731000999000001`,
  place: '#release',
} as const

export const READ_QUOTE = 'We ship on Friday, not Thursday.'

const REPLY = [
  `The release moved to Friday; Dana said so in [the release thread](${LEDGER.read}):`,
  `> ${READ_QUOTE}`,
  `The freeze was confirmed in [a later message](${LEDGER.unread}).`,
].join('\n\n')

const message = (type: 'assistant' | 'user', content: unknown[]) => ({
  type,
  message: { id: randomUUID(), type: 'message', role: type, model: 'claude', content },
  parent_tool_use_id: null,
  session_id: SESSION,
  uuid: randomUUID(),
})

/** A concise thread read as the Slack MCP server answers it. */
const THREAD = JSON.stringify({
  messages: ['', 'THREAD: [Dana Reyes <dana@example.com>]', `> > ${READ_QUOTE}`, '> > The freeze holds.'].join('\n'),
  pagination_info: 'There are no more messages in this thread.',
})

/**
 * An idle agent that read one Slack thread and cites it with a quote, then cites a message it
 * never saw. The ledger row stands in for what ingest records from the read.
 */
export async function seedLedgerReply(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const callId = 'toolu_ledger_read'
  const start = Date.now() - 5 * 60_000
  await db.idleTask(id, title, paths.checkout, new Date(start).toISOString())
  const input = { channel_id: CHANNEL, message_ts: THREAD_TS, response_format: 'concise' }
  const rows = [
    { kind: 'prompt', payload: { text: 'When does the release ship?' } },
    {
      kind: 'sdk',
      payload: message('assistant', [
        { type: 'tool_use', id: callId, name: 'mcp__plugin_slack_slack__slack_read_thread', input },
      ]),
    },
    { kind: 'sdk', payload: message('user', [{ type: 'tool_result', tool_use_id: callId, content: THREAD }]) },
    { kind: 'sdk', payload: message('assistant', [{ type: 'text', text: REPLY }]) },
  ]
  let at = start
  for (const row of rows) {
    at += 1500
    await db.message(id, row.kind, JSON.stringify(row.payload), new Date(at).toISOString())
  }
  await db.run(
    `INSERT INTO source_item (task_id, message_id, call_id, kind, container, ref, permalink, item_at, spans)
      SELECT ?, id, ?, 'slack', ?, ?, ?, ?, '["/messages"]' FROM task_message
      WHERE task_id = ? AND payload LIKE '%"tool_result"%'`,
    id,
    callId,
    CHANNEL,
    `slack:${CHANNEL}/${THREAD_TS}`,
    LEDGER.read,
    new Date(Number(THREAD_TS.split('.')[0]) * 1000).toISOString(),
    id,
  )
  await db.run(
    `INSERT INTO slack_name (id, kind, name, source, learned_at) VALUES (?, 'channel', 'release', 'test', ?)
      ON CONFLICT (id) DO NOTHING`,
    CHANNEL,
    new Date(start).toISOString(),
  )
  await db.close()
  return id
}

/** The agent's reply in the transcript. */
export const ledgerReply = (page: Page) =>
  page.getByRole('region', { name: 'Transcript' }).locator('[data-find-text]').filter({ hasText: 'The release moved' })
