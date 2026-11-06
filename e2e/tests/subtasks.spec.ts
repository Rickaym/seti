import type { Page } from '@playwright/test'
import { listedSubtasks, type Envelope, type SubtaskBrief, type TaskListEntry } from '@seti/shared'
import { paths } from './support/env.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { FANOUT, SEEDS, seedTask } from './support/subtasks.js'

const transcript = (page: Page) => page.getByRole('region', { name: 'Transcript' })
const rowOf = (page: Page, id: string) => page.locator(`[data-task-id="${id}"] button`)

test.describe('subtasks', () => {
  const titles = {
    fanOut: unique('Fan out release checks'),
    many: unique('Research six'),
    imported: unique('Imported'),
    plain: unique('No subagents'),
  }
  const ids = { fanOut: '', many: '', imported: '' }

  test.beforeAll(async () => {
    ids.fanOut = await seedTask(titles.fanOut, paths.checkout, SEEDS.fanOut())
    ids.many = await seedTask(titles.many, paths.checkout, SEEDS.many())
    ids.imported = await seedTask(titles.imported, paths.checkout, SEEDS.imported())
  })

  test('keeps every agent row one line with no subagent mark in the list', async ({ page, request }) => {
    const plain = await seedTask(titles.plain, paths.checkout, [])
    const briefs = await apiData<SubtaskBrief[]>(request, `/tasks/${ids.fanOut}/subtasks`)
    await page.route('**/api/tasks', async (route) => {
      const response = await route.fetch()
      const body = (await response.json()) as Envelope<TaskListEntry[]>
      const running = briefs.map((brief) =>
        brief.tool_use_id === FANOUT.dashboard.id ? { ...brief, status: 'running' as const, ended_at: null } : brief,
      )
      const data = body.data.map((task) => (task.id === ids.fanOut ? { ...task, ...listedSubtasks(running) } : task))
      await route.fulfill({ response, json: { ...body, data } })
    })
    await page.goto('/#agents')
    const [fanOut, many, imported, none] = [ids.fanOut, ids.many, ids.imported, plain].map((id) => rowOf(page, id))
    if (fanOut === undefined || many === undefined || imported === undefined || none === undefined) {
      throw new Error('four rows')
    }
    const heights = await Promise.all(
      [fanOut, many, imported, none].map(async (row) => (await row.boundingBox())?.height ?? 0),
    )
    expect(new Set(heights).size, heights.join(', ')).toBe(1)
    await expect(page.getByTestId('subagent-row')).toHaveCount(0)

    for (const row of [fanOut, many, imported, none]) {
      await expect(row.locator('svg.lucide-network')).toHaveCount(0)
    }
    await expect(fanOut.locator('[title$=": 1 subagent running"]')).toHaveCount(1)
  })

  test('the header button lists the subagents, and a subagent view keeps the strip', async ({ page }) => {
    await page.goto(`/#agents/${ids.fanOut}`)
    await expect(page.getByRole('main').getByRole('region', { name: 'Subagents' })).toHaveCount(0)
    const button = page.getByTestId('subagents-button')
    await expect(button).toHaveAccessibleName('4 subagents, 1 failed')
    await expect(button).toHaveText('')
    await button.click()
    const popover = page.getByTestId('subagents-popover')
    const listed = popover.getByTestId('subagent-row')
    await expect(listed).toHaveText([
      /Check dashboard CI/,
      /Read flaky test log/,
      /Review agent changes/,
      /Audit on-prem manifests/,
    ])
    await expect(listed.nth(3).getByRole('img', { name: 'failed' })).toBeVisible()
    const left = async (index: number) => (await listed.nth(index).getByRole('img').boundingBox())?.x ?? 0
    expect(await left(1)).toBeGreaterThan(await left(0))
    await listed.nth(1).click()
    await expect(page).toHaveURL(new RegExp(`#agents/${ids.fanOut}/sub/${FANOUT.nested.id}$`))
    await expect(popover).toHaveCount(0)

    const strip = page.getByRole('main').getByRole('region', { name: 'Subagents' })
    const toggle = strip.getByRole('button', { name: '4 subagents, 1 failed' })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const rows = strip.getByTestId('subagent-row')
    await expect(rows).toHaveCount(0)
    await toggle.click()
    await expect(rows.nth(1)).toHaveAttribute('aria-current', 'page')
    await page.reload()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await toggle.click()
    await page.reload()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await page.goto(`/#agents/${ids.imported}`)
    await page.getByRole('button', { name: '1 subagent, 1 no report' }).click()
    const imported = page.getByTestId('subagents-popover').getByTestId('subagent-row')
    await expect(imported).toHaveText(['Map voice-bot LLM seam'])
    await expect(imported.getByRole('img', { name: 'no report' })).toBeVisible()
    await imported.click()
    await expect(page).toHaveURL(new RegExp(`#agents/${ids.imported}/sub/toolu_seed_imported$`))
    await expect(page.getByText('This transcript holds no messages of this subagent.')).toBeVisible()
  })

  test('shows one card per subagent in the parent transcript', async ({ page }) => {
    await page.goto(`/#agents/${ids.fanOut}`)
    const pane = transcript(page)
    await expect(pane.getByText('All three checks are back')).toBeVisible()
    const cards = pane.getByTestId('subtask-card')
    await expect(cards).toHaveCount(3)
    await expect(cards.nth(0)).toContainText('done')
    await expect(cards.nth(0)).toContainText('Check dashboard CI')
    await expect(cards.nth(0)).toContainText('general-purpose | background')
    await expect(cards.nth(0).getByTestId('subtask-progress')).toHaveText('Dashboard CI')
    await expect(cards.nth(2)).toContainText('failed')
    await expect(pane.getByText(FANOUT.subagentCommand)).toHaveCount(0)
    await expect(pane.getByText(FANOUT.nestedCommand)).toHaveCount(0)

    const review = cards.nth(1)
    await review.getByText('Agent call and report').click()
    await expect(review.locator('pre', { hasText: FANOUT.agentReport })).toBeVisible()
    await expect(review.getByText('Seeded prompt: Review agent changes.')).toBeVisible()

    const dashboard = cards.nth(0)
    await dashboard.getByText('Agent call and report').click()
    await dashboard.getByRole('button', { name: 'Report' }).click()
    await expect(dashboard.locator('pre', { hasText: 'All 14 checks pass on #42' })).toBeVisible()
  })

  test('opens a subtask as its own read-only view', async ({ page }) => {
    await page.goto(`/#agents/${ids.fanOut}`)
    await transcript(page)
      .getByRole('button', { name: `Open subagent ${FANOUT.dashboard.description}` })
      .click()
    await expect(page).toHaveURL(new RegExp(`#agents/${ids.fanOut}/sub/${FANOUT.dashboard.id}$`))
    await expect(page.getByRole('heading', { name: FANOUT.dashboard.description })).toBeVisible()
    await expect(page.getByText('background', { exact: true })).toBeVisible()
    await expect(page.getByText(/Read-only\. The parent agent directs this subagent/)).toBeVisible()
    await expect(page.getByRole('textbox')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Stop subagent' })).toHaveCount(0)

    const pane = transcript(page)
    await expect(pane.getByTestId('tool-summary').getByText(FANOUT.subagentCommand, { exact: true })).toBeVisible()
    await expect(pane.getByText(FANOUT.nestedCommand)).toHaveCount(0)
    await expect(pane.getByTestId('subtask-report')).toContainText('All 14 checks pass on #42')
    await expect(pane.getByTestId('subtask-card')).toHaveCount(1)

    await pane.getByRole('button', { name: `Open subagent ${FANOUT.nested.description}` }).click()
    await expect(page).toHaveURL(new RegExp(`#agents/${ids.fanOut}/sub/${FANOUT.nested.id}$`))
    await expect(
      transcript(page).getByTestId('tool-summary').getByText(FANOUT.nestedCommand, { exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: FANOUT.dashboard.description, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`#agents/${ids.fanOut}/sub/${FANOUT.dashboard.id}$`))

    await page.getByRole('button', { name: titles.fanOut, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`#agents/${ids.fanOut}$`))
    await expect(transcript(page).getByTestId('subtask-card')).toHaveCount(3)
  })
})
