import type { Page } from '@playwright/test'
import { NO_LOGINS, type AccountStatus, type SystemInfo } from '@seti/shared'
import { expect, test } from './support/fixtures.js'

const MINUTE = 60_000

const bar = (page: Page) => page.getByRole('contentinfo')
const hint = (page: Page) => page.getByRole('tooltip')

/** Radix keeps a hint open until the pointer moves again outside it, so leave in a few steps. */
async function leave(page: Page): Promise<void> {
  await page.mouse.move(720, 10, { steps: 5 })
  await expect(hint(page)).toHaveCount(0)
}

const at = (ms: number) => new Date(Date.now() + ms).toISOString()

async function serve(page: Page, path: string, data: unknown): Promise<void> {
  await page.route(`**/api${path}`, async (route) => route.fulfill({ json: { data, meta: {} } }))
}

function account(windows: [key: string, label: string, used: number][]): AccountStatus {
  return {
    account: {
      email: 'e2e@seti.invalid',
      organization: 'Seti E2E',
      subscription_type: 'max',
      token_source: null,
      api_key_source: null,
      api_provider: null,
    },
    logins: NO_LOGINS,
    health: { state: 'ok', message: 'Using the Claude Code login of e2e@seti.invalid.' },
    usage: {
      source: 'usage_api',
      observed_at: at(0),
      windows: windows.map(([key, label, used]) => ({ key, label, utilization: used, resets_at: at(90 * MINUTE) })),
    },
    usage_note: null,
    rate_limit_event: null,
    task_error: null,
    fetched_at: at(0),
  }
}

test('sandbox off is a warning icon and auto permission mode is a plain one, each says its state on hover', async ({
  page,
}) => {
  const system: SystemInfo = { permission_mode: 'auto', sandbox: { enabled: false, token_mode: 'none' } }
  await serve(page, '/system', system)
  await page.goto('/#agents')

  const sandbox = bar(page).getByRole('button', { name: 'Sandbox off' })
  await expect(sandbox).toHaveText('')
  await expect(sandbox).toHaveAttribute('data-tone', 'warning')
  await expect(sandbox).not.toHaveClass(/bg-warning-fill/)
  await sandbox.hover()
  await expect(hint(page)).toContainText('Sandbox off')
  await expect(hint(page)).toContainText('Agent commands run with full access to this machine and the network.')

  await leave(page)
  const permission = bar(page).getByRole('status', { name: 'Permission mode auto' })
  await expect(permission).toHaveText('')
  await expect(permission).toHaveAttribute('data-tone', 'default')
  await permission.hover()
  await expect(hint(page)).toContainText('Permission mode: auto')
  await expect(hint(page)).toContainText('A classifier allows or turns down other calls')

  await sandbox.click()
  await expect(page).toHaveURL(/#settings\/sandbox$/)
})

const DAY = 24 * 60 * MINUTE

test('account usage dims the weekly fill behind the 5-hour one, past it when the week is fuller', async ({ page }) => {
  const status = account([
    ['five_hour', '5-hour', 24],
    ['seven_day', 'Weekly', 61],
  ])
  const weeklyReset = at(3 * DAY)
  await serve(page, '/account', {
    ...status,
    usage: status.usage && {
      ...status.usage,
      windows: status.usage.windows.map((w) => (w.key === 'seven_day' ? { ...w, resets_at: weeklyReset } : w)),
    },
  })
  await page.goto('/#agents')
  const item = bar(page).getByRole('button', {
    name: /^Claude account: 5-hour 24%, weekly 61%, 5-hour resets \d\d:\d\d [AP]M$/,
  })
  await expect(item).toHaveText('')
  const bars = item.getByTestId('usage-bar')
  await expect(bars).toHaveCount(1)
  await expect(bars).toHaveAttribute('data-window', 'five_hour')
  await expect(bars).toHaveAttribute('data-percent', '24')
  await expect(bars.getByTestId('usage-primary')).toHaveAttribute('style', /width: 24%/)
  const weekly = bars.getByTestId('usage-weekly')
  await expect(weekly).toHaveAttribute('style', /width: 61%/)
  await expect(weekly).toHaveAttribute('data-level', 'normal')
  await expect(weekly).toHaveCSS('opacity', '0.4')
  await expect(bars.getByTestId('usage-weekly-marker')).toHaveAttribute('data-position', 'above')

  await item.hover()
  await expect(hint(page)).toContainText('Plan usage')
  await expect(hint(page)).toContainText(/5-hour: 24%, resets in 1h (29|30)m \(\d\d:\d\d [AP]M\)\./)
  await expect(hint(page)).toContainText(/Weekly: 61%, resets in (3d 0h|2d 23h) \(\w{3} \d\d:\d\d [AP]M\)\./)
  await expect(hint(page)).toContainText(/Checked \d\d:\d\d [AP]M\. Click for details\.$/)

  await item.click()
  await expect(page).toHaveURL(/#settings\/account$/)
  const details = page.getByRole('main')
  await expect(details.getByRole('meter', { name: '5-hour usage' })).toHaveAttribute('aria-valuenow', '24')
  await expect(details.getByRole('meter', { name: 'Weekly usage' })).toHaveAttribute('aria-valuenow', '61')
  const weekday = new Date(weeklyReset).toLocaleString('en-US', { weekday: 'short', timeZone: 'Europe/Berlin' })
  await expect(details).toContainText(new RegExp(`resets in .+ \\(${weekday} \\d\\d:\\d\\d [AP]M\\)`))
  await expect(details).toContainText('e2e@seti.invalid')
  await expect(details).toContainText('Seti E2E')
})

test('account usage marks a weekly level under the 5-hour fill and keeps a hot model window apart', async ({
  page,
}) => {
  await serve(
    page,
    '/account',
    account([
      ['five_hour', '5-hour', 85],
      ['seven_day', 'Weekly', 30],
      ['seven_day_opus', 'Weekly Opus', 96],
      ['model:Fable', 'Weekly Fable', 12],
    ]),
  )
  await page.goto('/#agents')
  const item = bar(page).getByRole('button', { name: 'Claude account: 5-hour 85%, weekly 30%, weekly Opus 96%' })
  const bars = item.getByTestId('usage-bar')
  await expect(bars).toHaveCount(2)
  await expect(bars.first()).toHaveAttribute('data-level', 'warning')
  await expect(bars.first().getByTestId('usage-weekly')).toHaveAttribute('data-level', 'normal')
  await expect(bars.first().getByTestId('usage-weekly-marker')).toHaveAttribute('data-position', 'under')
  await expect(bars.last()).toHaveAttribute('data-window', 'seven_day_opus')
  await expect(bars.last()).toHaveAttribute('data-level', 'danger')

  await item.click()
  const details = page.getByRole('main')
  const used = { '5-hour': '85', Weekly: '30', 'Weekly Opus': '96', 'Weekly Fable': '12' }
  for (const [name, percent] of Object.entries(used)) {
    await expect(details.getByRole('meter', { name: `${name} usage` })).toHaveAttribute('aria-valuenow', percent)
  }
})

test('account usage leaves the weekly fill out when the week is unreported', async ({ page }) => {
  await serve(page, '/account', account([['five_hour', '5-hour', 40]]))
  await page.goto('/#agents')
  const item = bar(page).getByRole('button', { name: 'Claude account' })
  const bars = item.getByTestId('usage-bar')
  await expect(bars).toHaveCount(1)
  await expect(bars).toHaveAttribute('data-percent', '40')
  await expect(bars.getByTestId('usage-weekly')).toHaveCount(0)
  await expect(bars.getByTestId('usage-weekly-marker')).toHaveCount(0)
})

test('the API hint measures latency to Seti only while it shows, and reports the live stream', async ({ page }) => {
  const pings: number[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/ping') {
      pings.push(Date.now())
    }
  })
  await page.goto('/#agents')
  const item = bar(page).getByRole('status', { name: 'API up' })
  await expect(item).toBeVisible()
  expect(pings).toHaveLength(0)

  await item.hover()
  await expect(hint(page)).toContainText('Connected to the Seti server.')
  await expect(hint(page).getByTestId('api-latency')).toHaveText(
    /^Latency: \d+ ms median, \d+ ms jitter \([5-9] pings\)\.$/,
  )
  await expect(hint(page).getByTestId('api-stream')).toHaveText(/^Live stream: connected, last event \d+s ago\.$/)
  await expect(hint(page)).not.toContainText('Cloudflare')

  await leave(page)
  const settled = pings.length
  // Two system polls, 5 s apart, outlast the 2 s interval of a watch that failed to stop.
  for (let poll = 0; poll < 2; poll += 1) {
    await page.waitForRequest((request) => new URL(request.url()).pathname === '/api/system')
  }
  expect(pings).toHaveLength(settled)
})

test('warnings colour their item on the bar, only a critical one fills it, and items are 24px tall', async ({
  page,
}) => {
  const summary = (severity: 'warning' | 'critical') => ({
    sampled_at: at(0),
    memory_percent: 60,
    cpu_percent: 30,
    anomalies: 2,
    severity,
    headline: 'Load 17.2 on 8 CPUs',
  })
  let severity: 'warning' | 'critical' = 'warning'
  await page.route('**/api/resources/summary', async (route) =>
    route.fulfill({ json: { data: summary(severity), meta: {} } }),
  )
  const system: SystemInfo = { permission_mode: 'auto', sandbox: { enabled: true, token_mode: 'agent' } }
  await serve(page, '/system', system)
  await page.goto('/#agents')

  const resources = bar(page).getByRole('button', { name: 'Resources' })
  const permission = bar(page).getByRole('status', { name: 'Permission mode auto' })
  const background = async (item: ReturnType<typeof bar>) =>
    item.evaluate((element) => getComputedStyle(element).backgroundColor)
  await expect(resources).toHaveAttribute('data-tone', 'warning')
  expect(await background(resources)).toBe('rgba(0, 0, 0, 0)')
  expect(await background(permission)).toBe('rgba(0, 0, 0, 0)')
  const warningText = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.className = 'text-warning-text'
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  })
  expect(await resources.evaluate((element) => getComputedStyle(element).color)).toBe(warningText)

  for (const item of await bar(page).getByRole('button').all()) {
    const box = await item.boundingBox()
    expect(box?.height ?? 0, (await item.getAttribute('aria-label')) ?? '').toBeGreaterThanOrEqual(24)
  }

  severity = 'critical'
  await page.reload()
  await expect(resources).toHaveAttribute('data-tone', 'critical')
  await expect(resources).toHaveClass(/bg-warning-fill/)
})

test('the bar keeps work on the left and health past a hairline, with no per-state agent counts', async ({ page }) => {
  await page.goto('/#agents')
  const work = bar(page).getByRole('group', { name: 'Work' })
  const health = bar(page).getByRole('group', { name: 'Health' })
  await expect(work.getByRole('group', { name: 'EA', exact: true })).toBeVisible()
  await expect(health.getByRole('status', { name: 'API up' })).toBeVisible()
  await expect(health.getByRole('button', { name: /^Sandbox (on|off)$/ })).toBeVisible()
  await expect(health.getByRole('status', { name: /^Permission mode / })).toBeVisible()
  await expect(health).toHaveCSS('border-left-width', '1px')
  await expect(bar(page).getByRole('button', { name: /running agents|idle agents|routines/ })).toHaveCount(0)
})
