import fs from 'node:fs'
import path from 'node:path'
import type { Task } from '@seti/shared'
import { idleAgent } from './support/dreams.js'
import { DREAM_SUMMARY, LEFTOVER } from './support/fake-dream.js'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test.afterEach(async ({ request }) => {
  await request.put('/api/dreams/settings', { data: { cleanups: false } })
})

test('the Dreams view fits a phone, from what wants you to the night switcher', async ({ page, request }) => {
  await request.put('/api/dreams/settings', { data: { cleanups: true } })
  const id = await idleAgent(request)
  fs.writeFileSync(path.join((await apiData<Task>(request, `/tasks/${id}`)).cwd, LEFTOVER), 'stale\n')
  await request.post(`/api/tasks/${id}/dream`, { data: {} })
  await expect.poll(async () => (await apiData<unknown[]>(request, `/dreams/proposals?task=${id}`)).length).toBe(1)
  await page.goto('/#dreaming.dreams')
  const wants = page.getByRole('region', { name: 'Wants you' })
  await expect(wants).toContainText(LEFTOVER)
  await expect(page.getByRole('region', { name: 'Agents' })).toContainText(DREAM_SUMMARY)
  await expectFitsPhone(page, 'the Dreams view')
  const before = page.getByRole('button', { name: 'Night before' })
  await expectTouchTarget(before)
  await before.tap()
  await expect(page.getByText('No dreams this night.')).toBeVisible()
  const open = page.getByRole('button', { name: 'Night after' })
  await open.tap()
  await expect(wants.getByRole('button', { name: 'Open' })).toBeVisible()
  await expectTouchTarget(wants.getByRole('button', { name: 'Open' }))
  await wants.getByRole('button', { name: 'Open' }).tap()
  await expect(page).toHaveURL(new RegExp(`#agents/${id}`))
})
