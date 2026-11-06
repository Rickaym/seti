import type { Page } from '@playwright/test'
import { CART_AGENT, DEMO_WORKER, enterDemo, INFRA_AGENT } from './support/demo.js'
import { expect, test } from './support/fixtures.js'

const main = (page: Page) => page.getByRole('main')

async function openAgent(page: Page, title: string): Promise<void> {
  await main(page).getByRole('button', { name: title }).first().click()
  await expect(main(page).getByRole('heading', { name: title }).first()).toBeVisible()
}

test.use(DEMO_WORKER)

test('a visitor enters, answers a scripted permission prompt and gets a PR', async ({ page }) => {
  test.setTimeout(60_000)
  await enterDemo(page)
  await expect(main(page).getByRole('region', { name: 'Needs you' })).toContainText(INFRA_AGENT)

  await openAgent(page, INFRA_AGENT)
  const card = main(page).getByRole('region', { name: 'Permission request for Bash' })
  await expect(card).toContainText('terraform apply')
  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(main(page).getByText(/Nothing really ran/)).toBeVisible()

  await page.goto('/#agents')
  await openAgent(page, CART_AGENT)
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.fill('Take the second fix and open a PR')
  await reply.press('Enter')
  // The scripted turn plays seven steps, each a moment apart, before its last reply.
  await expect(main(page).getByText(/so I opened a PR/)).toBeVisible({ timeout: 30_000 })
  await expect(main(page).getByText('#483', { exact: true }).first(), 'the PR links to the agent').toBeVisible()
})

test('the server refuses what the demo leaves out, whatever the page asks', async ({ page }) => {
  await enterDemo(page)
  const refused = async (method: string, path: string, data: unknown = {}) => {
    const response = await page.request.fetch(path, { method, data, headers: { origin: new URL(page.url()).origin } })
    expect(response.status(), `${method} ${path}`).toBe(403)
    expect(await response.text()).toContain('Not in the demo')
  }
  await refused('GET', '/api/terminals/t1')
  await refused('POST', '/api/ssh/keys', { name: 'k' })
  await refused('PUT', '/api/sandbox', { enabled: false })
  await refused('POST', '/api/plugins/installed', { id: 'evil@market' })
  await refused('POST', '/api/tasks', { prompt: 'x', cwd: '/' })
  await refused('POST', '/api/tasks/start', { prompt: 'x', cwd: '/etc' })
  await refused('POST', '/hooks/abc', {})
})
