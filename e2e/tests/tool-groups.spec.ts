import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import type { Envelope, Task } from '@seti/shared'
import { paths } from './support/env.js'
import { BURST_COMMANDS, BURST_DONE, burstPrompt, releaseStep } from './support/fake-steps.js'
import { expect, test, unique } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { BURST, BURST_NEEDLE, MIXED, seedMixedGroup, seedToolBurst } from './support/tool-groups.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const transcript = (page: Page) => page.getByRole('region', { name: 'Transcript' })
const groups = (page: Page) => transcript(page).getByTestId('tool-group')

test('folds a burst of commands into one row that opens to compact calls and a full command', async ({ page }) => {
  const id = await seedToolBurst(unique('Burst'))
  await page.goto(`/#agents/${id}`)
  const pane = transcript(page)
  await expect(pane.getByText(BURST.outro)).toBeVisible()

  await expect(groups(page)).toHaveCount(2)
  const burst = groups(page).first()
  const toggle = burst.getByRole('button', { name: /Ran 10 commands/ })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(burst).toContainText('Check the PR state')
  await expect(burst.getByTestId('tool-group-failed')).toContainText('1')
  await expect(burst.getByTestId('tool-outward')).toHaveAccessibleName('1 outward call')
  const kinds = burst.getByTestId('tool-group-kind')
  await expect(kinds).toHaveCount(1)
  await expect(kinds).toHaveAttribute('title', 'Bash: 10, 1 failed')
  await expect(kinds).toHaveClass(/text-destructive/)
  await expect(groups(page).nth(1)).toContainText('Ran 1 command, read 2 files')
  const mixed = groups(page).nth(1).getByTestId('tool-group-kind')
  await expect(mixed).toHaveCount(2)
  await expect(mixed.nth(0)).toHaveAttribute('data-kind', 'command')
  await expect(mixed.nth(1)).toHaveAttribute('title', 'Read: 2')
  await expect(mixed.nth(1)).not.toHaveClass(/text-destructive/)
  await expect(pane.getByText(BURST.middle)).toBeVisible()
  await expect(pane.getByText('line-30: value-30')).toHaveCount(0)

  const monitor = pane.locator('details').filter({ hasText: BURST.monitor.description })
  await expect(monitor).toHaveCount(1)
  await expect(monitor.getByTestId('tool-background')).toHaveText('watching')
  await expect(groups(page).filter({ hasText: BURST.monitor.description })).toHaveCount(0)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const summaries = burst.getByTestId('tool-summary')
  await expect(summaries).toHaveCount(10)
  await expect(summaries.nth(0)).toHaveText('List app pods')
  await expect(summaries.nth(1)).toHaveText('git status --short')
  await expect(summaries.nth(2)).toHaveText("cat > /tmp/values.yaml <<'EOF'")
  await expect(summaries.nth(3)).toHaveText('./scripts/push-image.sh --tag "$IMAGE_TAG"')
  await expect(burst.getByTestId('tool-failed')).toHaveText('exit 2')
  await expect(burst.getByText('line-59: value-59')).toBeHidden()

  const heredoc = burst.locator('details').nth(2)
  await heredoc.locator('summary').click()
  await expect(heredoc.getByText('line-59: value-59')).toBeAttached()
  await expect(heredoc.getByRole('button', { name: 'Copy command' })).toBeVisible()
  const box = await heredoc.locator('pre').first().boundingBox()
  expect(box?.height ?? 0).toBeLessThanOrEqual(260)

  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(summaries).toHaveCount(0)
})

test('a long group label truncates in a narrow transcript instead of scrolling it sideways', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 })
  const id = await seedMixedGroup(unique('Mixed group'))
  await page.goto(`/#agents/${id}`)
  const pane = transcript(page)
  await expect(pane.getByText(MIXED.outro)).toBeVisible()
  const group = groups(page).first()
  await expect(group.getByRole('button', { name: new RegExp(MIXED.label) })).toBeVisible()
  await expect(group.getByText(/^\d+m \d\ds$/u)).toBeInViewport({ ratio: 1 })
  const sideways = async () => pane.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(await sideways(), 'folded group scrolls the transcript sideways').toBeLessThanOrEqual(0)
  const label = group.getByTestId('tool-group-label')
  await expect(label).toHaveAttribute('title', MIXED.label)
  expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)

  await group.getByRole('button', { name: new RegExp(MIXED.label) }).click()
  await expect(group.getByTestId('tool-summary')).toHaveCount(MIXED.calls.length)
  expect(await sideways(), 'open group scrolls the transcript sideways').toBeLessThanOrEqual(0)
})

test('find opens the group and the call that hold a hit', async ({ page }) => {
  const id = await seedToolBurst(unique('Burst find'))
  await page.goto(`/#agents/${id}`)
  await expect(transcript(page).getByText(BURST.outro)).toBeVisible()
  const toggle = groups(page)
    .first()
    .getByRole('button', { name: /Ran 10 commands/ })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')

  await page.keyboard.press('Control+f')
  await page.getByTestId('chat-find-input').fill(BURST_NEEDLE)
  await expect(page.getByTestId('chat-find-count')).toHaveText('No matches')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await page.getByTestId('chat-find').getByRole('button', { name: 'Tools' }).click()
  await expect(page.getByTestId('chat-find-count')).toHaveText('1 of 1')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const hit = page.locator('[data-find-current]')
  await expect(hit).toContainText(`REVISION 7 ${BURST_NEEDLE}`)
  await expect(hit.getByText(`REVISION 7 ${BURST_NEEDLE}`)).toBeInViewport()
})

test('with grouping off every call keeps a compact row of its own', async ({ page }) => {
  await page.goto('/#settings/general')
  const setting = page.getByRole('main').getByRole('button', { name: 'Group calls', exact: true })
  await expect(setting).toHaveAttribute('aria-pressed', 'true')
  await setting.click()
  await expect(setting).toHaveAttribute('aria-pressed', 'false')

  const id = await seedToolBurst(unique('Burst ungrouped'))
  await page.goto(`/#agents/${id}`)
  const pane = transcript(page)
  await expect(pane.getByText(BURST.outro)).toBeVisible()
  await expect(groups(page)).toHaveCount(0)
  await expect(pane.getByTestId('tool-summary')).toHaveCount(14)
  await expect(pane.getByText('line-30: value-30')).toBeHidden()
})

test('streamed calls join the running group in place', async ({ page, request }) => {
  const gate = fs.mkdtempSync(path.join(paths.root, 'burst-gate-'))
  const response = await request.post('/api/tasks', {
    data: { title: unique('Checks'), prompt: burstPrompt(gate), cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await page.goto(`/#agents/${id}`)
  releaseStep(gate, 0)

  const group = groups(page)
  await expect(group).toContainText('Ran 2 commands')
  await expect(group.getByTestId('tool-group-running')).toBeVisible()
  const handle = await group.elementHandle()
  const height = (await group.boundingBox())?.height ?? 0

  for (let n = 1; n < BURST_COMMANDS.length - 1; n++) {
    releaseStep(gate, n)
    await expect(group).toContainText(`Ran ${String(n + 2)} commands`)
    await expect(group.getByTestId('tool-group-last')).toHaveText(BURST_COMMANDS[n + 1] ?? '')
    await expect(group.getByTestId('tool-group-running')).toBeVisible()
    expect(await group.evaluate((el, first) => el === first, handle)).toBe(true)
    expect(Math.abs(((await group.boundingBox())?.height ?? 0) - height)).toBeLessThan(1)
  }

  releaseStep(gate, BURST_COMMANDS.length - 1)
  await expect(transcript(page).getByText(BURST_DONE)).toBeVisible()
  await expect(group).toContainText(`Ran ${String(BURST_COMMANDS.length)} commands`)
  await expect(group.getByTestId('tool-group-running')).toHaveCount(0)
  expect(await group.evaluate((el, first) => el === first, handle)).toBe(true)
  await expect(group.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
})
