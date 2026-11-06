import type { Page } from '@playwright/test'
import type {
  AccountStatus,
  EaHealth,
  PermissionRequest,
  PrCheck,
  PullRequest,
  ResourceSummary,
  SandboxStatus,
} from '@seti/shared'
import { mockChannels } from './channel-mocks.js'
import { AGENTS, at, PR_URL } from './seed.js'
import { INFRA_COMMAND } from '../../server/src/demo/content/cast.js'

const envelope = <T>(data: T) => ({ data, meta: {} })

const check = (name: string, detail: string, state: PrCheck['state'] = 'success'): PrCheck => ({
  name,
  state,
  detail,
  url: null,
})

/** The storefront PR: green CI, a ready preview, changes asked for in two open threads. */
const STOREFRONT_PR: PullRequest = {
  key: 'storefront-482',
  repo_id: 'acme/storefront',
  repo_slug: 'acme/storefront',
  number: 482,
  title: 'fix(checkout): retry card captures on gateway timeouts',
  url: PR_URL,
  draft: false,
  author: 'seti-agent',
  head_ref: 'fix/checkout-capture-retry',
  base_ref: 'main',
  head_oid: '9c1e4b7a2f',
  updated_at: at(4),
  review_decision: 'changes_requested',
  mergeable: 'mergeable',
  labels: ['checkout', 'bug'],
  ci: 'success',
  checks: [
    check('lint', 'success'),
    check('typecheck', 'success'),
    check('unit', 'success'),
    check('e2e (chromium)', 'success'),
    check('preview deploy', 'success'),
  ],
  unresolved_threads: 2,
  preview: { state: 'ready', url: 'https://pr-482.storefront.example', commit: '9c1e4b7', stale: false },
  preview_host: null,
  tasks: [{ id: AGENTS.checkout, title: 'Retry card captures on gateway timeouts', status: 'running' }],
  related: [],
}

const PERMISSION: PermissionRequest = {
  id: 'perm-infra-1',
  task_id: AGENTS.infra,
  tool_name: 'Bash',
  summary: INFRA_COMMAND,
  input: JSON.stringify({ command: INFRA_COMMAND, description: 'Apply the upgrade' }, null, 2),
  reason: 'No rule allows terraform apply',
  suggestions: ['Bash(terraform apply:*)'],
  state: 'pending',
  message: null,
  created_at: at(1),
  decided_at: null,
}

const CALM: ResourceSummary = {
  sampled_at: at(0),
  memory_percent: 38,
  cpu_percent: 22,
  anomalies: 0,
  severity: 'ok',
  headline: null,
}

const ACCOUNT: AccountStatus = {
  account: null,
  logins: {
    accounts: [
      {
        id: 'work',
        name: 'Work',
        email: null,
        organization: 'Acme',
        plan: 'max',
        created_at: at(60 * 24 * 40),
        updated_at: at(60 * 24),
      },
    ],
    active_id: 'work',
    unsaved: null,
  },
  health: { state: 'ok', message: 'Signed in' },
  usage: {
    source: 'usage_api',
    observed_at: at(1),
    windows: [
      { key: 'five_hour', label: '5h', utilization: 34, resets_at: at(-140) },
      { key: 'seven_day', label: 'Week', utilization: 51, resets_at: at(-60 * 24 * 3) },
    ],
  },
  usage_note: null,
  rate_limit_event: null,
  task_error: null,
  fetched_at: at(1),
}

const EA_READY: EaHealth = {
  ok: true,
  configured: true,
  missing: [],
  model: 'gpt-realtime',
  text_model: 'gpt-4.1',
  chat_missing: [],
  turn: true,
}

/** Answers the calls that would reach GitHub, the host or a live agent with fixed data. */
export async function mockLiveServices(page: Page): Promise<void> {
  await mockChannels(page)
  await page.route(/\/api\/prs\/lookup$/, async (route) => {
    const asked = new Set((route.request().postDataJSON() as { urls: string[] }).urls)
    await route.fulfill({ json: envelope([STOREFRONT_PR].filter((pr) => asked.has(pr.url))) })
  })
  await page.route(/\/api\/tasks\/[^/]+\/permission-requests$/, async (route) => {
    const infra = route.request().url().includes(AGENTS.infra)
    await route.fulfill({ json: envelope(infra ? [PERMISSION] : []) })
  })
  await page.route(/\/api\/sandbox$/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback()
      return
    }
    const response = await route.fetch()
    const body = (await response.json()) as { data: SandboxStatus }
    const data = { ...body.data, token_mode: 'agent', claude_credential: 'token', mcp_servers: [] }
    await route.fulfill({ response, json: { ...body, data } })
  })
  await page.route(/\/api\/tasks\/[^/]+\/seen$/, async (route) => route.fulfill({ json: envelope(null) }))
  await page.route('**/api/resources/summary', async (route) => route.fulfill({ json: envelope(CALM) }))
  await page.route('**/api/account', async (route) => route.fulfill({ json: envelope(ACCOUNT) }))
  await page.route('**/api/ea/health', async (route) => route.fulfill({ json: EA_READY }))
}
