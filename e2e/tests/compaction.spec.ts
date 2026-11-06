import { COMPACT_DEFAULTS, type CompactSettings, type TaskCompactRule } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { apiData, expect, test, toasts } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV, startShellAgent } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('preferences set what every compaction keeps and go back to the defaults', async ({ page, request }) => {
  await page.goto('/#settings/agents')
  const card = page.getByRole('region', { name: 'Compaction' })
  await expect(card.getByRole('button', { name: 'Auto compact', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(card.getByRole('spinbutton', { name: 'Compact at' })).toBeDisabled()

  await card.getByRole('textbox', { name: 'Compact instructions' }).fill('Keep the files changed.')
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(toasts(page).filter({ hasText: 'Compaction saved' })).toBeVisible()
  expect((await apiData<CompactSettings>(request, '/compact')).rule).toEqual({
    ...COMPACT_DEFAULTS,
    instructions: 'Keep the files changed.',
  })

  await page.reload()
  await expect(card.getByRole('textbox', { name: 'Compact instructions' })).toHaveValue('Keep the files changed.')
  await card.getByRole('button', { name: 'Defaults' }).click()
  await card.getByRole('button', { name: 'Save' }).click()
  await expect.poll(async () => (await apiData<CompactSettings>(request, '/compact')).rule).toEqual(COMPACT_DEFAULTS)
})

test('an agent gets a compaction rule of its own from its settings, and the default back', async ({
  page,
  request,
}) => {
  const id = await startShellAgent(request)
  await page.goto(`/#agents/${id}`)
  await openAgentSettings(page, 'Session')
  const details = page.getByRole('dialog').getByLabel('Agent details')
  await expect(details).toContainText('Auto (default)')

  await details.getByRole('button', { name: 'Change compaction' }).click()
  await details.getByRole('spinbutton', { name: 'Context window' }).fill('200')
  await details.getByRole('spinbutton', { name: 'Compact at' }).fill('70')
  await details.getByRole('textbox', { name: 'Compact instructions' }).fill('Keep open decisions.')
  await details.getByRole('button', { name: 'Save' }).click()
  await expect(details).toContainText('Auto, 200k window at 70%, with instructions (own)')
  const own = await apiData<TaskCompactRule>(request, `/tasks/${id}/compact`)
  expect(own.override).toEqual({ auto: true, window_k: 200, threshold_pct: 70, instructions: 'Keep open decisions.' })

  await details.getByRole('button', { name: 'Change compaction' }).click()
  await details.getByRole('button', { name: 'Auto compact', exact: true }).click()
  await expect(details.getByRole('spinbutton', { name: 'Context window' })).toBeDisabled()
  await details.getByRole('button', { name: 'Save' }).click()
  await expect(details).toContainText('Manual only, with instructions (own)')

  await details.getByRole('button', { name: 'Change compaction' }).click()
  await details.getByRole('button', { name: 'Default' }).click()
  await expect(details).toContainText('Auto (default)')
  expect((await apiData<TaskCompactRule>(request, `/tasks/${id}/compact`)).override).toBeNull()
})
