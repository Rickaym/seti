import { expect, test } from './support/fixtures.js'
import { findNode, seedShipped } from './support/home.js'

test('Home is the landing page and counts what each agent shipped', async ({ page }) => {
  const agent = await seedShipped('Home shipped')
  await page.goto('/')
  await expect(page.getByRole('main').getByRole('heading', { name: 'Home' })).toBeVisible()
  await expect(
    page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Home' }),
  ).toHaveAttribute('aria-current', 'page')
  const metrics = page.getByRole('complementary', { name: 'Metrics' })
  await expect(metrics.getByRole('heading', { name: 'Shipped' })).toBeVisible()
  await expect(metrics.getByRole('row', { name: /^Merged/ })).toBeVisible()
  await expect(
    metrics.getByRole('list', { name: 'PRs merged per day, last 30 days' }).getByRole('listitem'),
  ).toHaveCount(30)
  const row = metrics.getByRole('button', { name: new RegExp(agent.title) })
  await expect(row).toContainText('1 turn')
  await expect(row).toContainText('1')
  await row.click()
  await expect(page).toHaveURL(new RegExp(`#agents/${agent.id}$`))
})

test('hovering a node shows its card, and clicking the node opens the agent', async ({ page }) => {
  test.slow()
  const agent = await seedShipped('Home hover')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(page.getByRole('complementary', { name: 'Metrics' }).getByText(agent.title)).toBeVisible()
  const found = await findNode(page, agent.title, async (x, y) => page.mouse.move(x, y))
  expect(found).not.toBeNull()
  const card = page.getByTestId('home-card')
  await expect(card).toContainText('Merged 30d')
  await expect(card).toContainText('Uses github')
  await page.mouse.click(found?.x ?? 0, found?.y ?? 0)
  await expect(page).toHaveURL(new RegExp(`#agents/${agent.id}$`))
})

test('graph filters are toggles that stay set after a reload', async ({ page }) => {
  await seedShipped('Home filters')
  await page.goto('/')
  const toolbar = page.getByRole('toolbar', { name: 'Graph' })
  const tools = toolbar.getByRole('button', { name: 'Tools' })
  await expect(tools).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText(/with \d+ repos, [1-9]\d* MCP servers/)).toBeAttached()
  await tools.click()
  await expect(tools).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByText(/, 0 MCP servers/)).toBeAttached()
  await toolbar.getByRole('button', { name: 'Archived' }).click()
  await page.reload()
  await expect(toolbar.getByRole('button', { name: 'Tools' })).toHaveAttribute('aria-pressed', 'false')
  await expect(toolbar.getByRole('button', { name: 'Archived' })).toHaveAttribute('aria-pressed', 'true')
})
