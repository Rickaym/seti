import { paths } from './support/env.js'
import { expect, test, unique } from './support/fixtures.js'
import { tapMoreAction } from './support/phone-agent.js'
import { SEEDS, seedTask } from './support/subtasks.js'

test('subagent cards fit a phone without scrolling the transcript sideways', async ({ page }) => {
  const id = await seedTask(unique('Phone fan out'), paths.checkout, SEEDS.fanOut())
  await page.goto(`/#agents/${id}`)
  const pane = page.getByRole('region', { name: 'Transcript' })
  const cards = pane.getByTestId('subtask-card')
  await expect(cards).toHaveCount(3)
  expect(await pane.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
  const edge = await pane.evaluate((el) => el.getBoundingClientRect().right)
  for (const open of await pane.getByRole('button', { name: /^Open subagent/ }).all()) {
    const box = await open.boundingBox()
    expect((box?.x ?? Infinity) + (box?.width ?? 0)).toBeLessThanOrEqual(edge)
  }
})

test('the phone header shows PRs, and the More sheet lists the subagents', async ({ page }) => {
  const id = await seedTask(unique('Phone subagents'), paths.checkout, SEEDS.fanOut())
  await page.goto(`/#agents/${id}`)
  const header = page.getByTestId('agent-header')
  await expect(header.getByTestId('prs-button')).toBeVisible()
  await expect(header.getByTestId('subagents-button')).toHaveCount(0)
  await tapMoreAction(page, 'Subagents')
  const sheet = page.getByTestId('subagents-sheet')
  await expect(sheet).toContainText('4 subagents')
  const rows = sheet.getByTestId('subagent-row')
  await expect(rows).toHaveCount(4)
  await rows.first().tap()
  await expect(sheet).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`#agents/${id}/`))
})
