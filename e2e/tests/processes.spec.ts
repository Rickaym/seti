import type { AgentProcesses } from '@seti/shared'
import { LIMIT_PROMPT, SHELL_COMMAND } from './support/fake-claude.js'
import { apiData, expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV, startShellAgent } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('lists the background shell an agent started, with its output, and stops it', async ({ page, request }) => {
  const id = await startShellAgent(request)
  await page.goto(`/#agents/${id}`)
  const button = page.getByRole('button', { name: /^Processes/ })
  await expect(button).toHaveAccessibleName('Processes, 1 running')
  await expect(page.getByTestId('processes-badge')).toHaveText('1')
  const badgeTop = (await page.getByTestId('processes-badge').boundingBox())?.y ?? -1
  expect(badgeTop, 'the badge sits inside its button, so no header edge clips it').toBeGreaterThanOrEqual(
    (await button.boundingBox())?.y ?? Infinity,
  )

  await button.click()
  const panel = page.getByRole('dialog', { name: 'Processes' })
  const shells = panel.getByRole('region', { name: 'Background shells' })
  const row = shells.getByTestId('shell-row')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('running')
  await expect(row).toContainText('Run the dev server')
  await expect(row).toContainText(SHELL_COMMAND)
  await expect(row).toContainText(/pid \d+/)

  await row.getByRole('button', { name: 'Show output of Run the dev server' }).click()
  await expect(row.getByLabel('Output of Run the dev server', { exact: true })).toContainText(
    'dev server listening on http://localhost:5173',
  )

  const tree = panel.getByRole('list', { name: 'Process tree' })
  await expect(tree.getByTestId('process-row').first()).toContainText('Claude Code')
  await expect(tree).not.toContainText(SHELL_COMMAND)

  await row.getByRole('button', { name: 'Stop Run the dev server' }).click()
  await expect(row).toContainText('stopped')
  await expect(row.getByRole('button', { name: 'Stop Run the dev server' })).toHaveCount(0)
  const view = async () => apiData<AgentProcesses>(request, `/tasks/${id}/processes`)
  expect((await view()).shells.map((shell) => shell.status)).toEqual(['killed'])
  await expect.poll(async () => (await view()).processes.filter((p) => p.kind === 'command')).toEqual([])

  await panel.getByRole('button', { name: 'Close processes' }).click()
  await expect(panel).toBeHidden()
  await expect(button).toHaveAccessibleName('Processes')
  await expect(page.getByTestId('processes-badge')).toHaveCount(0)
})

test('marks a background shell Claude Code stopped at its time limit', async ({ page, request }) => {
  const id = await startShellAgent(request)
  await page.goto(`/#agents/${id}`)
  await expect(page.getByTestId('processes-badge')).toHaveText('1')
  const sent = await request.post(`/api/tasks/${id}/messages`, { data: { prompt: LIMIT_PROMPT } })
  expect(sent.ok(), 'POST /messages').toBe(true)
  await expect(page.getByTestId('processes-badge')).toHaveCount(0)

  await page.getByRole('button', { name: /^Processes/ }).click()
  const row = page.getByRole('dialog', { name: 'Processes' }).getByTestId('shell-row')
  await expect(row).toContainText('time limit')
  await expect(row.getByRole('button', { name: 'Stop Run the dev server' })).toHaveCount(0)
  const view = await apiData<AgentProcesses>(request, `/tasks/${id}/processes`)
  expect(view.shells.map((shell) => [shell.status, shell.stop_cause])).toEqual([['killed', 'time_limit']])
})
