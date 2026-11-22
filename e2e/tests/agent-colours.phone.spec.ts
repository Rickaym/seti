import { randomUUID } from 'node:crypto'
import type { Task } from '@seti/shared'
import { expandColors, openAgentSettings } from './support/agent-settings.js'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { tapMoreAction } from './support/phone-agent.js'
import { expectTouchTarget } from './support/phone-layout.js'
import { SEEDS, seedTask } from './support/subtasks.js'

test('a phone colours an agent with a preset or a typed hex and the header takes it', async ({ page, request }) => {
  const title = unique('Phone painted')
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, title, paths.checkout, new Date().toISOString())
  await db.close()
  await page.goto(`/#agents/${id}`)
  const sheet = await openAgentSettings(page)
  const chip = sheet.getByRole('button', { name: 'Colour None' })
  await expectTouchTarget(chip, 'Colour', 'both')
  await expandColors(sheet)
  const pink = sheet.getByRole('group', { name: 'Color' }).getByRole('button', { name: 'Pink', exact: true })
  const hex = sheet.getByRole('textbox', { name: 'Hex colour' })
  for (const target of [pink, hex, sheet.getByLabel('Pick any colour')]) {
    await expectTouchTarget(target, 'colour control', 'both')
  }
  await pink.click()
  await expect(pink).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).color).toBe('#e05b9e')

  await hex.fill('#0a7')
  await hex.press('Enter')
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).color).toBe('#00aa77')
  await expect(pink).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Escape')
  const header = page
    .locator('[data-agent-color="#00aa77"] .agent-tint')
    .filter({ has: page.getByTestId('agent-header') })
  await expect(header).toBeVisible()
  await expect(header).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
})

test('a phone opens the subagents from the More sheet with touch-sized rows', async ({ page }) => {
  const id = await seedTask(unique('Phone fan out'), paths.checkout, SEEDS.fanOut())
  await page.goto(`/#agents/${id}`)
  await expect(page.getByRole('main').getByRole('region', { name: 'Subagents' })).toHaveCount(0)
  await tapMoreAction(page, 'Subagents')
  const sheet = page.getByTestId('subagents-sheet')
  const rows = sheet.getByTestId('subagent-row')
  await expect(rows).toHaveCount(4)
  await sheet.evaluate(async (el) => Promise.all(el.getAnimations().map(async (run) => run.finished)))
  await expectTouchTarget(rows.first())
  const width = page.viewportSize()?.width ?? 0
  expect((await sheet.boundingBox())?.width ?? 0).toBeGreaterThan(width - 32)
  await rows.first().click()
  await expect(page).toHaveURL(new RegExp(`#agents/${id}/sub/`))
})
