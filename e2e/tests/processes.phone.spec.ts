import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV, startShellAgent } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('the processes panel fits a phone, with its output and stop buttons in reach', async ({ page, request }) => {
  const id = await startShellAgent(request)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  const button = page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: /^Processes/ })
  await expect(button).toHaveAccessibleName('Processes, 1 running')
  await button.tap()
  const panel = page.getByRole('dialog', { name: 'Processes' })
  const row = panel.getByTestId('shell-row')
  await row.getByRole('button', { name: 'Show output of Run the dev server' }).tap()
  await expect(row.getByLabel('Output of Run the dev server', { exact: true })).toContainText('dev server listening')
  await expect(panel.getByTestId('process-row').first()).toBeVisible()
  await expectFitsPhone(page, 'processes panel')
  await row.getByRole('button', { name: 'Stop Run the dev server' }).tap()
  await expect(row).toContainText('stopped')
})
