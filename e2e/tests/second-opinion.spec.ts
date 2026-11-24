import { openAgentSettings, showSection } from './support/agent-settings.js'
import { expect, test, unique } from './support/fixtures.js'
import { OPINION, seedSecondOpinion } from './support/second-opinions.js'

test('a second opinion reads as one line and opens to the question and the framed answer', async ({ page }) => {
  const id = await seedSecondOpinion(unique('Opinion'))
  await page.goto(`/#agents/${id}`)
  const pane = page.getByRole('region', { name: 'Transcript' })
  await expect(pane.getByText(OPINION.after)).toBeVisible()
  const row = pane.locator('details', { has: page.getByTestId('opinion-model') })
  await expect(row.getByTestId('opinion-model')).toHaveText('Asked gpt-5.5:')
  await expect(row.getByTestId('tool-summary')).toHaveText(OPINION.question)
  await expect(row.getByTestId('opinion-cost')).toHaveText('$0.03 est.')
  await row.locator('summary').click()
  await expect(row.getByRole('region', { name: 'Question' })).toContainText(OPINION.question)
  const answer = row.getByRole('region', { name: 'Answer' })
  await expect(answer).toContainText('gpt-5.5 on Codex, 41 s')
  await expect(answer).toContainText('flush() in queue.ts')
  await expect(answer).toContainText('</second-opinion>')
  await page.screenshot({ path: test.info().outputPath('second-opinion-desktop.png') })
})

test('its cost shows under the agent cost, by runtime', async ({ page }) => {
  const id = await seedSecondOpinion(unique('Opinion cost'))
  await page.goto(`/#agents/${id}`)
  const section = await showSection(await openAgentSettings(page), 'Session')
  await expect(section.getByRole('list', { name: 'Second opinions' })).toHaveText(
    'Includes $0.03 est. for 1 second opinion on Codex',
  )
})
