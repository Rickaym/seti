import fs from 'node:fs'
import path from 'node:path'
import type { Browser, Page } from '@playwright/test'
import type { PermissionRequest, PullRequest, WorkspaceEntry } from '@seti/shared'
import { apiData, expect, test } from '../tests/support/fixtures.js'
import { newPage, openContext, type Device, type Theme } from './capture.js'
import { CHAT_AGENTS, GATEWAY_PR, ROLLOUT_COMMAND, seedChatAgents } from './chat-seed.js'
import { SHOTS_SERVER_ENV } from './clock.js'
import { at } from './seed.js'

const OUT = process.env.SETI_CHAT_SHOTS ?? path.join(import.meta.dirname, '../test-results/chat-view')
const DESIGNS = (process.env.SETI_CHAT_DESIGNS ?? 'now,a,b,c').split(',')

const envelope = <T>(data: T) => ({ data, meta: {} })

const GATEWAY: PullRequest = {
  key: 'api-512',
  repo_slug: 'acme/api',
  number: 512,
  title: 'fix(gateway): resume sessions instead of reconnecting from scratch',
  url: GATEWAY_PR,
  draft: false,
  author: 'seti-agent',
  head_ref: 'fix/fast-reconnect',
  base_ref: 'main',
  head_oid: '7d02e9a11c',
  updated_at: at(3),
  review_decision: 'changes_requested',
  mergeable: 'mergeable',
  labels: [],
  ci: 'failure',
  checks: [{ name: 'e2e (chromium)', state: 'failure', detail: 'failure', url: null }],
  unresolved_threads: 1,
  preview: { state: 'none', url: null, commit: null, stale: false },
  preview_host: null,
  tasks: [{ id: CHAT_AGENTS.gateway, title: 'Cut reconnect latency in the media gateway', status: 'running' }],
  related: [],
}

const PERMISSION: PermissionRequest = {
  id: 'perm-rollout-1',
  task_id: CHAT_AGENTS.rollout,
  tool_name: 'Bash',
  kind: 'tool',
  summary: ROLLOUT_COMMAND,
  input: JSON.stringify({ command: ROLLOUT_COMMAND, description: 'Restart the queue worker' }, null, 2),
  reason: 'No rule allows kubectl rollout',
  suggestions: ['Bash(kubectl -n staging rollout:*)'],
  editable: false,
  state: 'pending',
  message: null,
  created_at: at(1),
  decided_at: null,
  timeout_at: null,
  timed_out: false,
}

async function mockChat(page: Page): Promise<void> {
  await page.route(/\/api\/prs\/lookup$/, async (route) => {
    const asked = new Set((route.request().postDataJSON() as { urls: string[] }).urls)
    await route.fulfill({ json: envelope({ prs: [GATEWAY].filter((pr) => asked.has(pr.url)), pending: [] }) })
  })
  await page.route(/\/api\/tasks\/[^/]+\/permission-requests$/, async (route) => {
    const mine = route.request().url().includes(CHAT_AGENTS.rollout)
    await route.fulfill({ json: envelope(mine ? [PERMISSION] : []) })
  })
}

const panel = (i: string, agent: string, x: number, y: number) => ({ i, agent, x, y, w: 6, h: 12 })

async function putGrid(page: Page): Promise<void> {
  const [workspace] = await apiData<WorkspaceEntry[]>(page.request, '/workspaces')
  const panels = [
    panel('a', CHAT_AGENTS.gateway, 0, 0),
    panel('b', CHAT_AGENTS.guide, 6, 0),
    panel('c', CHAT_AGENTS.rollout, 0, 12),
    panel('d', CHAT_AGENTS.flaky, 6, 12),
  ]
  const response = await page.request.put(`/api/mods/grid/layouts/${workspace?.id ?? ''}`, {
    data: { layout: { panels, locked: false, perScreen: null } },
  })
  expect(response.ok(), 'PUT the grid layout').toBe(true)
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => document.fonts.ready)
  await page.mouse.move(0, 0)
  await page.waitForTimeout(1500)
}

async function save(page: Page, name: string): Promise<void> {
  await settle(page)
  fs.mkdirSync(OUT, { recursive: true })
  await page.screenshot({ path: path.join(OUT, `${name}.png`), animations: 'disabled', caret: 'hide', scale: 'device' })
}

async function open(browser: Browser, base: string, device: Device, theme: Theme): Promise<Page> {
  const context = await openContext(browser, base, { device, theme })
  const page = await newPage(context)
  await mockChat(page)
  return page
}

async function grid(page: Page, design: string): Promise<void> {
  await page.goto(`/?chat=${design}#agents`)
  const toggle = page.getByRole('button', { name: 'Grid', exact: true })
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') {
    await toggle.click()
  }
  await expect(page.locator('[data-grid-item]')).toHaveCount(4)
  await expect(page.getByText('Allow Bash?')).toBeVisible()
}

/** Opens the hidden work of the first panel the way each design offers it. */
async function openDetail(page: Page, design: string): Promise<void> {
  const first = page.locator('[data-grid-item]').first()
  if (design === 'now') {
    await first.getByTestId('tool-group').first().getByRole('button').first().click()
  } else if (design === 'a') {
    await first.getByTestId('work-line').first().getByRole('button').first().click()
  } else if (design === 'b') {
    await first.getByRole('button', { name: 'History' }).click()
  } else {
    await first.getByTestId('lane-marks').first().click()
  }
}

test.use({ serverEnv: SHOTS_SERVER_ENV })

test('chat view prototypes', async ({ browser, baseURL }) => {
  const base = baseURL ?? ''
  await seedChatAgents()
  for (const design of DESIGNS) {
    const desk = await open(browser, base, 'desktop', 'dark')
    await putGrid(desk)
    await grid(desk, design)
    await save(desk, `${design}-grid`)
    await settle(desk)
    await desk
      .locator('[data-grid-item]')
      .first()
      .screenshot({ path: path.join(OUT, `panel-1-${design}.png`), scale: 'device' })
    await openDetail(desk, design)
    await save(desk, `${design}-detail`)
    await desk.context().close()

    const light = await open(browser, base, 'desktop', 'light')
    await grid(light, design)
    await save(light, `${design}-grid-light`)
    await light.context().close()

    for (const [n, id] of [
      [1, CHAT_AGENTS.gateway],
      [2, CHAT_AGENTS.rollout],
    ] as const) {
      const phone = await open(browser, base, 'phone', 'dark')
      await phone.goto(`/?chat=${design}#agents/${id}`)
      await expect(phone.getByRole('main').getByRole('heading').first()).toBeVisible()
      await save(phone, `${design}-phone-${String(n)}`)
      await phone.context().close()
    }
  }
})
