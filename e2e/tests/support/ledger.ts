import { randomUUID } from 'node:crypto'
import { expect, type Page } from '@playwright/test'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

const SESSION = 'ledger-session'
const CHANNEL = 'C0LEDGER001'
const THREAD_TS = '1731000000.123456'
const PLAN_SHA = 'c0ffee1'.padEnd(40, '0')

/** The links the reply cites: a thread the agent read, and a message it never saw. */
export const LEDGER = {
  read: `https://acme.slack.com/archives/${CHANNEL}/p1731000000123456`,
  unread: `https://acme.slack.com/archives/${CHANNEL}/p1731000999000001`,
  /** A file at a branch name, read when that branch was at `PLAN_SHA`. */
  branch: 'https://github.com/acme/notes/blob/main/docs/plan.md',
  asRead: 'as read at c0ffee1',
  place: '#release',
  /** The thread's day as the reader's locale shows it; the e2e browsers read en-US. */
  day: 'Nov 7, 2024',
} as const

export const READ_QUOTE = 'We ship on Friday, not Thursday.'

const REPLY = [
  `The release moved to Friday; Dana said so in [the release thread](${LEDGER.read}):`,
  `> ${READ_QUOTE}`,
  'That settles the date.',
  `The freeze was confirmed in [a later message](${LEDGER.unread}).`,
  `The steps are in [the plan](${LEDGER.branch}).`,
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
  const fileCall = 'toolu_ledger_file'
  const file = `${paths.checkout}/docs/plan.md`
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
    {
      kind: 'sdk',
      payload: message('assistant', [{ type: 'tool_use', id: fileCall, name: 'Read', input: { file_path: file } }]),
    },
    {
      kind: 'sdk',
      payload: message('user', [{ type: 'tool_result', tool_use_id: fileCall, content: '1\tFreeze, then ship.' }]),
    },
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
      WHERE task_id = ? AND payload LIKE ?`,
    id,
    callId,
    CHANNEL,
    `slack:${CHANNEL}/${THREAD_TS}`,
    LEDGER.read,
    new Date(Number(THREAD_TS.split('.')[0]) * 1000).toISOString(),
    id,
    `%"tool_use_id":"${callId}"%`,
  )
  await db.run(
    `INSERT INTO source_item (task_id, message_id, call_id, kind, container, ref, permalink, spans, branches)
      SELECT ?, id, ?, 'file', 'acme/notes', ?, ?, '["~numbered"]', ARRAY['main'] FROM task_message
      WHERE task_id = ? AND payload LIKE ?`,
    id,
    fileCall,
    `file:acme/notes:docs/plan.md@${PLAN_SHA}`,
    `https://github.com/acme/notes/blob/${PLAN_SHA}/docs/plan.md`,
    id,
    `%"tool_use_id":"${fileCall}"%`,
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

/**
 * Switches the page to its dark theme and waits until its colours rest. A transition on this
 * page's buttons can end without settling its promise, so this reads colours, not animations.
 */
export async function toDark(page: Page): Promise<void> {
  const background = async () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const light = await background()
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(background).not.toBe(light)
  const resting = async () =>
    page.evaluate(async () => {
      const before = getComputedStyle(document.body).backgroundColor
      await new Promise((resolve) => setTimeout(resolve, 200))
      return getComputedStyle(document.body).backgroundColor === before
    })
  await expect.poll(resting).toBe(true)
}
