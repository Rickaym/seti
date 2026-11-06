import { expect, test } from './support/fixtures.js'
import { findNode, seedShipped } from './support/home.js'

/** The docked card covers the bottom of the graph, so taps search the part above it. */
const ABOVE_CARD = 0.6

test('a phone taps a node for its card and opens the agent from it', async ({ page }) => {
  test.slow()
  const agent = await seedShipped('Phone home')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(page.getByRole('main').getByRole('heading', { name: 'Home' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Metrics' }).getByText(agent.title)).toBeAttached()
  const found = await findNode(page, agent.title, async (x, y) => page.touchscreen.tap(x, y), ABOVE_CARD)
  expect(found).not.toBeNull()
  const card = page.getByTestId('home-card')
  await expect(card).toContainText('Merged 30d')
  await expect(page).toHaveURL(/\/(#home)?$/)
  await card.getByRole('button', { name: 'Open' }).click()
  await expect(page).toHaveURL(new RegExp(`#agents/${agent.id}$`))
})

test('a phone reads the metrics below the graph and nothing scrolls sideways', async ({ page }) => {
  const agent = await seedShipped('Phone metrics')
  await page.goto('/')
  const metrics = page.getByRole('complementary', { name: 'Metrics' })
  const graph = page.getByTestId('home-graph')
  await expect(graph).toBeVisible()
  await metrics.getByRole('heading', { name: 'Shipped' }).scrollIntoViewIfNeeded()
  await expect(metrics.getByRole('heading', { name: 'Shipped' })).toBeInViewport()
  const graphBox = await graph.boundingBox()
  const metricsBox = await metrics.boundingBox()
  expect(metricsBox?.y ?? 0).toBeGreaterThanOrEqual((graphBox?.y ?? 0) + (graphBox?.height ?? 0) - 1)
  const row = metrics.getByRole('button', { name: new RegExp(agent.title) })
  await row.scrollIntoViewIfNeeded()
  expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40)
  const toolbar = page.getByRole('toolbar', { name: 'Graph' })
  for (const name of ['Repos', 'Tools', 'Subagents', 'Archived', 'Cost', 'Fit']) {
    await expect(toolbar.getByRole('button', { name })).toBeVisible()
  }
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(wide).toBe(false)
})
