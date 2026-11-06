import { expect, test } from './support/fixtures.js'
import {
  boxOf,
  linkedCount,
  linkManyPrs,
  LOGIN_PR,
  MANY_PRS,
  mockManyStatuses,
  startAgent,
} from './support/many-prs.js'
import { openAgentPrs } from './support/phone-agent.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const TARGET_PX = 44

test('150 linked PRs open from More in a sheet of touch-sized rows, and the reply box stays', async ({
  page,
  request,
}) => {
  await mockManyStatuses(page)
  const many = await startAgent(request, 'Phone many PRs')
  await linkManyPrs(many.id)
  await page.goto(`/#agents/${many.id}`)
  const header = page.getByTestId('agent-header')
  const height = (await boxOf(header)).height
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await expect(reply).toBeInViewport({ ratio: 1 })
  await expectFitsPhone(page, 'agent with many PRs')

  const sheet = await openAgentPrs(page)
  const rows = sheet.getByRole('listitem')
  await expect(rows.first()).toBeVisible()
  for (const row of (await rows.all()).slice(0, 5)) {
    expect((await boxOf(row)).height).toBeGreaterThanOrEqual(TARGET_PX)
  }
  const sheetBox = await boxOf(sheet)
  expect(sheetBox.y).toBeGreaterThan(0)
  const sheetRow = (n: number) => sheet.getByRole('listitem', { name: `Pull request many#${String(n)}` })
  await expect(sheetRow(MANY_PRS).getByRole('img', { name: '3 unresolved review threads' })).toBeVisible()
  await expectFitsPhone(page, 'linked PRs sheet')
  await sheet.getByRole('textbox', { name: 'Filter linked PRs' }).fill('147')
  await expect(sheetRow(MANY_PRS - 3).getByRole('img', { name: '1 unresolved review thread' })).toBeVisible()
  await expectFitsPhone(page, 'linked PR with an unresolved thread')

  await sheet.getByRole('textbox', { name: 'Filter linked PRs' }).fill('login')
  const row = sheet.getByRole('listitem', { name: `Pull request many#${String(LOGIN_PR)}` })
  await expect(rows).toHaveCount(1)
  const unlink = row.getByRole('button', { name: `Unlink many#${String(LOGIN_PR)}` })
  expect(Math.min((await boxOf(unlink)).width, (await boxOf(unlink)).height)).toBeGreaterThanOrEqual(TARGET_PX)
  await unlink.tap()
  await expect(row).toBeHidden()
  await expect.poll(async () => linkedCount(request, many.id)).toBe(MANY_PRS - 1)
  await page.getByRole('button', { name: 'Undo' }).tap()
  await expect.poll(async () => linkedCount(request, many.id)).toBe(MANY_PRS)
  await expect(row).toBeVisible()

  await sheet.getByRole('button', { name: 'Close linked PRs' }).tap()
  await expect(sheet).toBeHidden()
  await expect(reply).toBeInViewport({ ratio: 1 })
  expect((await boxOf(header)).height).toBe(height)
})
