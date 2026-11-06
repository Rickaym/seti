import fs from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { Envelope, Task } from '@seti/shared'
import { paths } from './support/env.js'
import { planPrompt, releaseStep } from './support/fake-steps.js'
import { expect, test, unique } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { SEEDS, seedTask } from './support/subtasks.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const strip = (page: Page) => page.getByRole('main').getByTestId('todo-strip')
const toggle = (page: Page) => strip(page).getByRole('button', { name: /^Todos: / })
const labels = async (locator: Locator) => locator.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
const lights = (page: Page) => strip(page).getByTestId('todo-row').getByRole('img')

test("the todo strip follows the agent's own list live, with its status lights", async ({ page, request }) => {
  const gate = fs.mkdtempSync(path.join(paths.root, 'todo-gate-'))
  const response = await request.post('/api/tasks', {
    data: { title: unique('Todos'), prompt: planPrompt(gate), cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await page.goto(`/#agents/${id}`)

  await expect(toggle(page)).toHaveAccessibleName('Todos: 0/3 done; now: Reading the code')
  await expect(strip(page).getByTestId('todo-counts')).toHaveText('0/3 done')
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
  await toggle(page).click()
  await expect(strip(page).getByTestId('todo-row')).toHaveText(['Reading the code', 'Fix the bug', 'Run the tests'])
  await expect.poll(async () => labels(lights(page))).toEqual(['in progress', 'pending', 'pending'])

  releaseStep(gate, 0)
  await expect(strip(page).getByTestId('todo-counts')).toHaveText('1/3 done')
  await expect(toggle(page)).toContainText('Fixing the bug')
  await expect.poll(async () => labels(lights(page))).toEqual(['in progress', 'pending', 'completed'])

  releaseStep(gate, 1)
  await expect(strip(page).getByTestId('todo-counts')).toHaveText('2/3 done')
  await expect
    .poll(async () => labels(lights(page)))
    .toEqual(['in progress; the agent asks you', 'completed', 'completed'])
  await expect(page.locator(`[data-task-id="${id}"]`).getByTestId('agent-todo-count')).toHaveText('2/3')

  await page.reload()
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(strip(page).getByTestId('todo-row')).toHaveCount(3)
})

test('an agent without todos shows no strip, and its subagents open from a header button', async ({ page }) => {
  const plain = await seedTask(unique('No todos'), paths.checkout, [])
  await page.goto(`/#agents/${plain}`)
  await expect(page.getByRole('button', { name: 'Find in this chat' })).toBeVisible()
  await expect(strip(page)).toHaveCount(0)
  await expect(page.getByTestId('subagents-button')).toHaveCount(0)

  const id = await seedTask(unique('Seeded todos'), paths.checkout, SEEDS.todos())
  await page.goto(`/#agents/${id}`)
  await expect(toggle(page)).toHaveAccessibleName('Todos: 1/3 done; now: Fixing the bug')
  await expect(page.getByRole('main').getByRole('region', { name: 'Subagents' })).toHaveCount(0)

  const button = page.getByTestId('subagents-button')
  await expect(button).toHaveAccessibleName('1 subagent')
  await expect(button).toHaveText('')
  await button.click()
  const rows = page.getByTestId('subagents-popover').getByTestId('subagent-row')
  await expect(rows).toHaveText([/^Read flaky test log/])
  await rows.first().click()
  await expect(page).toHaveURL(new RegExp(`#agents/${id}/sub/toolu_seed_todo_agent$`))
})
