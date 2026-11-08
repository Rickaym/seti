import type { Locator } from '@playwright/test'
import { paths } from './support/env.js'
import { expect, test, unique } from './support/fixtures.js'
import { SEEDS, seedTask } from './support/subtasks.js'

const TARGET_PX = 44

const labels = async (locator: Locator) => locator.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))

test("a phone shows the agent's todos full width under its header", async ({ page }) => {
  const id = await seedTask(unique('Phone todos'), paths.checkout, SEEDS.todos())
  await page.goto(`/#agents/${id}`)
  const strip = page.getByRole('main').getByTestId('todo-strip')
  const toggle = strip.getByRole('button', { name: 'Todos: 1/3 done; now: Fixing the bug' })
  const width = page.viewportSize()?.width ?? 0
  expect((await strip.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(width - 1)
  expect((await toggle.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(TARGET_PX)
  await expect(strip.getByTestId('todo-counts')).toHaveText('1/3 done')
  await toggle.click()
  const rows = strip.getByTestId('todo-row')
  await expect(rows).toHaveText(['Fixing the bug', 'Run the tests', 'Read the code'])
  await expect
    .poll(async () => labels(rows.getByRole('img')))
    .toEqual(['in progress; the agent is idle', 'pending', 'completed'])
  await expect(rows.last().getByText('Read the code')).toHaveCSS('text-decoration-line', 'line-through')
})
