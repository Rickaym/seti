import { expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { BURST, seedToolBurst } from './support/tool-groups.js'

test('a burst of commands folds into rows that fit a phone, closed and open', async ({ page }) => {
  const id = await seedToolBurst(unique('Phone burst'))
  await page.goto(`/#agents/${id}`)
  const pane = page.getByRole('region', { name: 'Transcript' })
  await expect(pane.getByText(BURST.outro)).toBeVisible()
  const burst = pane.getByTestId('tool-group').first()
  await expect(burst).toContainText('Ran 10 commands')
  await expect(burst.getByTestId('tool-group-kind')).toBeHidden()
  await expectFitsPhone(page, 'folded tool calls')

  await burst.getByRole('button', { name: /Ran 10 commands/ }).tap()
  const heredoc = burst.locator('details').nth(2)
  await heredoc.locator('summary').tap()
  await expect(heredoc.getByRole('button', { name: 'Copy command' })).toBeVisible()
  await expectFitsPhone(page, 'an open tool call in a group')
})
