import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { APIRequestContext, Page } from '@playwright/test'
import type { CapabilitiesSnapshot, EaHealth, McpServer, PullRequest } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { EA_HEADERS, paths } from './support/env.js'
import { botSays, fakeEa } from './support/fake-ea.js'
import { addScratchRepos, expect, test as base } from './support/fixtures.js'
import { openAgentPrs } from './support/phone-agent.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { mockResources } from './support/resources.js'
import { SEEDS, seedTask as seedRows } from './support/subtasks.js'

const TITLE = 'Migrate the dashboard websocket reconnection logic to the exponential backoff helper and add tests'
/** Channel names stop at 80 characters. */
const NAME = TITLE.slice(0, 64)
const WORD = 'a_long_identifier_without_any_break_that_keeps_going_'.repeat(3)
const PR_URL = 'https://github.com/e2e/docs/pull/1'
const URL_TEXT = `${PR_URL}/files#diff-${'a1b2c3'.repeat(12)}`
const READY: EaHealth = { ok: true, configured: true, missing: [], model: 'gpt-4.1-mini', turn: true }

interface Seeded {
  task: string
  fanout: string
  files: string
}

/** Seeded once per worker, since every test only reads what it finds. */
let seeded: Promise<Seeded> | null = null

const assistant = (text: string) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
    session_id: 'layout-session',
    uuid: randomUUID(),
  })

const REPLY = [
  `Checked ${URL_TEXT} and \`${WORD}\`.`,
  '',
  '| Column one | Column two | Column three | Column four |',
  '| --- | --- | --- | --- |',
  '| alpha value | beta value that is long | gamma value longer still | delta |',
  '',
  '```ts',
  `export const line = '${'x'.repeat(200)}'`,
  '```',
].join('\n')

async function seedAgents(): Promise<Pick<Seeded, 'task' | 'files'>> {
  const db = openSeedDb()
  const at = new Date().toISOString()
  const task = randomUUID()
  await db.idleTask(task, TITLE, paths.checkout, at)
  await db.message(task, 'prompt', JSON.stringify({ text: `Look at ${URL_TEXT} and ${WORD}` }), at)
  await db.message(task, 'sdk', assistant(REPLY), at)
  await db.run(`INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'user')`, task, PR_URL, at)
  await db.run(`INSERT INTO team_member (task_id, handle, muted, updated_at) VALUES (?, 'layout', 0, ?)`, task, at)
  for (const text of [`@all ${WORD}`, `See ${URL_TEXT}`, `\`\`\`\n${'y'.repeat(180)}\n\`\`\``]) {
    await db.run(
      `INSERT INTO team_message (author_kind, author_task_id, author_handle, text, mentions, created_at)
       VALUES ('task', ?, 'layout', ?, '[]', ?)`,
      task,
      text,
      at,
    )
  }
  const files = randomUUID()
  const dir = path.join(paths.root, `layout-${files.slice(0, 8)}`)
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'out', `plan-${'with-a-long-name-'.repeat(3)}.md`), `# Plan\n\n- ${WORD}\n`)
  await db.idleTask(files, 'Welcome pack', dir, at)
  await db.close()
  return { task, files }
}

async function seedSettings(request: APIRequestContext): Promise<void> {
  await addScratchRepos(request)
  await request.post('/api/channels', { data: { name: `Alerts ${NAME}`, preset: 'generic', subscribe_ea: false } })
  await request.post('/api/channels/pollers', {
    data: { name: `Watcher ${NAME}`, script: 'export default async () => []', subscribe_ea: false },
  })
  await request.post('/api/channels/reminders', {
    data: { name: `Nudge ${NAME}`, script: "export default () => 'Stand up'", subscribe_ea: false },
  })
  await request.post('/api/connections', {
    data: {
      name: 'layout_vendor_key',
      kind: 'key',
      env: 'LAYOUT_VENDOR_KEY',
      values: { value: 'vendor-secret-value' },
    },
  })
  await request.post('/api/ea/history/messages', {
    headers: EA_HEADERS,
    data: { entries: [{ kind: 'message', message: { role: 'user', content: `What about ${URL_TEXT}?` } }] },
  })
}

async function seed(request: APIRequestContext): Promise<Seeded> {
  await seedSettings(request)
  const fanout = await seedRows(`Fan out ${TITLE}`, paths.checkout, SEEDS.fanOut())
  return { ...(await seedAgents()), fanout }
}

const test = base.extend<{ data: Seeded }>({
  data: async ({ page, request }, use) => {
    seeded ??= seed(request)
    const data = await seeded
    await mockServices(page)
    await use(data)
  },
})

test.use({ permissions: ['microphone'] })

const server = (name: string, status: McpServer['status'], error: string | null = null): McpServer => ({
  name,
  status,
  scope: 'user',
  source: null,
  transport: { type: 'http', target: `https://${name}.example.com/mcp/with/a/long/path` },
  server_version: '1.0.0',
  connector_id: null,
  error,
  tools: [
    { name: `${name}_list_everything`, description: WORD, read_only: true, destructive: false, open_world: true },
  ],
  sign_in: status === 'needs-auth' ? 'required' : 'none',
})

const CAPABILITIES: CapabilitiesSnapshot = {
  cwd: paths.checkout,
  probed_at: '2026-09-30T09:00:00.000Z',
  duration_ms: 900,
  pending_timed_out: false,
  account: { email: 'someone@example.com', organization: null, subscription_type: 'max', api_provider: null },
  servers: [
    server('github-enterprise-server-with-a-long-name', 'connected'),
    server('linear', 'needs-auth'),
    server('broken', 'failed', WORD),
  ],
  skill_groups: [
    { prefix: 'e2e', commands: [{ name: 'e2e:resolve', description: WORD, argument_hint: '<pr>', aliases: [] }] },
  ],
  builtin_commands: [{ name: 'compact', description: 'Compact the conversation', argument_hint: '', aliases: [] }],
  subagents: [{ name: 'general-purpose-reviewer', description: WORD, model: 'opus' }],
  models: [],
}

const LONG_PR: PullRequest = {
  key: 'docs-1',
  repo_id: 'e2e/docs',
  repo_slug: 'e2e/docs',
  number: 1,
  title: TITLE,
  url: PR_URL,
  draft: false,
  author: 'e2e',
  head_ref: `feat/${'long-branch-name-'.repeat(4)}1`,
  base_ref: 'main',
  head_oid: 'abc1234',
  updated_at: '2026-09-28T01:00:00Z',
  review_decision: 'changes_requested',
  mergeable: 'mergeable',
  labels: ['enhancement', 'needs-review', 'frontend'],
  ci: 'failure',
  checks: [{ name: 'build / typecheck, lint and test', state: 'failure', detail: 'exit 1', url: null }],
  unresolved_threads: 0,
  preview: { state: 'ready', url: 'https://pr-1.docs.example', commit: 'abc1234', stale: false },
  preview_host: 'docs-pr-1.seti.localhost',
  tasks: [{ id: 'layout-task', title: TITLE, status: 'idle' }],
  related: [],
}

async function mockServices(page: Page): Promise<void> {
  await page.route(/\/api\/prs\/lookup$/, async (route) => route.fulfill({ json: { data: [LONG_PR], meta: {} } }))
  await page.route(/\/api\/capabilities(\?.*)?$/, async (route) =>
    route.fulfill({ json: { data: CAPABILITIES, meta: {} } }),
  )
  await mockResources(page)
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: READY }))
  await page.route('**/api/ea/ice', async (route) => route.fulfill({ json: { iceServers: [] } }))
  await fakeEa(page)
}

const main = (page: Page) => page.getByRole('main')

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`/#${hash}`)
  await expect(main(page).getByRole('heading').first()).toBeVisible()
}

test('agents fit a phone: list, detail, details, files, dialogs and subagents', async ({ page, data }) => {
  const { task, files, fanout } = data
  await open(page, 'agents')
  await expectFitsPhone(page, 'agents list')
  await main(page).getByRole('button', { name: 'New agent' }).click()
  await expect(main(page).getByRole('heading', { name: /^Your move/ })).toBeVisible()
  await page.getByLabel('Message').fill(WORD)
  await expectFitsPhone(page, 'start page')
  await page.getByLabel('Message').fill('')
  await open(page, 'agents')
  await main(page).getByRole('button', { name: 'More list actions' }).click()
  await expectFitsPhone(page, 'agent list menu')
  await page.getByRole('menuitem', { name: 'Import sessions' }).click()
  await expect(page.getByRole('dialog', { name: 'Import sessions' })).toBeVisible()
  await expectFitsPhone(page, 'import sessions dialog')
  await page.keyboard.press('Escape')

  await open(page, `agents/${task}`)
  await expect(main(page).getByRole('heading', { name: TITLE, level: 2 })).toBeVisible()
  await expectFitsPhone(page, 'agent detail')
  const prs = await openAgentPrs(page)
  await expect(prs.getByRole('button', { name: 'Fix CI' })).toBeVisible()
  await expectFitsPhone(page, 'failing checks')
  await prs.getByRole('button', { name: 'Close linked PRs' }).tap()
  await expect(prs).toBeHidden()
  await main(page).getByRole('button', { name: 'Agent settings' }).click()
  await expect(page.getByRole('dialog').getByLabel('Agent details')).toBeVisible()
  await expectFitsPhone(page, 'agent details')
  const archive = page.getByRole('dialog').getByRole('button', { name: 'Archive', exact: true })
  await archive.scrollIntoViewIfNeeded()
  await expect(archive).toBeInViewport()
  await page.keyboard.press('Escape')
  // The closing dialog hands focus back to its button once it unmounts, which hides the list.
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const reply = page.getByLabel('Reply', { exact: true })
  await reply.fill('/')
  await expect(page.getByRole('listbox')).toBeVisible()
  await expectFitsPhone(page, 'slash commands')
  await reply.fill('')
  await reply.press('Escape')
  await reply.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Rewind' })).toBeVisible()
  await expectFitsPhone(page, 'rewind dialog')
  await page.keyboard.press('Escape')

  await open(page, `agents/${fanout}`)
  await expectFitsPhone(page, 'agent with subagents')
  await open(page, `agents/${fanout}/sub/toolu_seed_dash`)
  await expectFitsPhone(page, 'subagent')

  await open(page, `agents/${files}`)
  await main(page).getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).click()
  const panel = page.getByRole('region', { name: 'Files', exact: true })
  await panel.getByRole('button', { name: /plan-with-a-long-name/ }).click()
  await expect(panel.getByText('Plan', { exact: true })).toBeVisible()
  await expectFitsPhone(page, 'files panel')
})

test('context and the EA fit a phone', async ({ page, data: _data }) => {
  await open(page, 'context')
  await expectFitsPhone(page, 'context')
  await open(page, 'context/user')
  await expectFitsPhone(page, 'context file')

  await open(page, 'ea')
  await main(page).getByRole('button', { name: 'Call', exact: true }).click()
  const card = main(page).getByRole('region', { name: 'Live call' })
  await expect(card.getByTestId('ea-call-status')).toHaveText('Listening')
  await botSays(page, 'user-input', {
    text: `Which PRs ${WORD}`,
    input_type: 'transcription',
    final: true,
    timestamp: '',
  })
  await botSays(page, 'llm-function-call-in-progress', { function_name: 'list_pull_requests', tool_call_id: 'x1' })
  await expect(card.locator('[data-kind="action"]')).toContainText('list_pull_requests')
  await expectFitsPhone(page, 'EA call')
  await card.getByRole('button', { name: 'Hang up', exact: true }).click()
})

test('the drawer, group chat and EA sheet fit a phone', async ({ page, data: _data }) => {
  await open(page, 'agents')
  await page.getByRole('button', { name: 'Menu' }).click()
  await expect(page.getByRole('dialog', { name: 'SETI' })).toBeVisible()
  await expectFitsPhone(page, 'nav drawer')
  await page.keyboard.press('Escape')

  await page.getByRole('banner').getByTestId('team-chat-toggle').click()
  const chat = page.getByRole('dialog', { name: 'Group chat' })
  await expect(chat.getByText(`See ${URL_TEXT}`)).toBeVisible()
  await expectFitsPhone(page, 'group chat')
  await chat.getByRole('button', { name: 'Close group chat' }).click()

  const bar = page.getByRole('contentinfo')
  await bar.getByRole('group', { name: 'EA', exact: true }).getByRole('button', { name: 'EA', exact: true }).click()
  await expect(page.getByRole('region', { name: 'EA call' })).toBeVisible()
  await expectFitsPhone(page, 'EA sheet')
})

const SETTINGS = [
  'general',
  'agents',
  'notifications',
  'repos',
  'ea',
  'resources',
  'channels',
  'about',
  'account',
  'mcp',
  'plugins',
  'skills',
  'subagents',
  'signin',
  'devices',
  'sandbox',
  'permissions',
  'connections',
  'credentials',
  'secrets',
  'ssh',
  'audit',
] as const

test('every settings page fits a phone', async ({ page, data: _data }) => {
  test.setTimeout(60_000)
  await open(page, 'settings')
  await expectFitsPhone(page, 'settings list')
  for (const key of SETTINGS) {
    await open(page, `settings/${key}`)
    await expect(main(page).getByRole('heading', { level: 2 })).toBeVisible()
    await expectFitsPhone(page, `settings ${key}`)
  }
})

test('settings dialogs fit a phone: channels and MCP servers', async ({ page, data: _data }) => {
  test.setTimeout(60_000)
  await open(page, 'settings/channels')
  await main(page).getByRole('button', { name: 'New', exact: true }).click()
  await expectFitsPhone(page, 'channel sources')
  await page
    .getByRole('list', { name: 'Channel sources' })
    .getByRole('button', { name: /Webhook/ })
    .click()
  await expect(page.getByRole('dialog', { name: 'New webhook' })).toBeVisible()
  await expectFitsPhone(page, 'new webhook')
  await page.keyboard.press('Escape')
  const card = main(page).getByRole('region', { name: `Watcher ${NAME}` })
  await card.getByRole('button', { name: 'Edit' }).click()
  const editor = page.getByRole('dialog')
  await editor.getByRole('button', { name: 'Test run' }).click()
  await expect(editor.getByRole('region', { name: 'Test run result' })).toBeVisible()
  await expectFitsPhone(page, 'poller editor')
  await page.keyboard.press('Escape')
  const reminder = main(page).getByRole('region', { name: `Nudge ${NAME}` })
  await reminder.getByRole('button', { name: 'Edit' }).click()
  const reminderEditor = page.getByRole('dialog')
  await reminderEditor.getByRole('button', { name: 'Test run' }).click()
  await expect(reminderEditor.getByTestId('reminder-test-status')).toContainText('Would deliver')
  await expectFitsPhone(page, 'reminder editor')
  await page.keyboard.press('Escape')

  await open(page, 'settings/mcp')
  await main(page).getByRole('button', { name: 'Add MCP server' }).click()
  await expect(page.getByRole('dialog', { name: 'Add MCP server' })).toBeVisible()
  await expectFitsPhone(page, 'add MCP server')
})

test.describe('in landscape', () => {
  test.use({ viewport: { width: 844, height: 390 } })

  test('a landscape phone keeps the one-pane layout', async ({ page, data }) => {
    await open(page, `agents/${data.task}`)
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeHidden()
    await expect(main(page).getByRole('button', { name: 'Back to agents' })).toBeVisible()
    await expectFitsPhone(page, 'landscape agent')
    await open(page, 'prs/docs-1')
    await expectFitsPhone(page, 'landscape pull request')
    await open(page, 'settings/mcp')
    await expectFitsPhone(page, 'landscape MCP servers')
  })
})
