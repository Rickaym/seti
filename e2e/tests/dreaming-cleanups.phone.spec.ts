import fs from 'node:fs'
import path from 'node:path'
import type { Task } from '@seti/shared'
import { dreams, idleAgent } from './support/dreams.js'
import { LEFTOVER } from './support/fake-dream.js'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test.afterEach(async ({ request }) => {
  await request.put('/api/dreams/settings', { data: { cleanups: false } })
})

test('clean-ups are allowed and restored on a phone', async ({ page, request }) => {
  await request.put('/api/dreams/settings', { data: { cleanups: true } })
  const id = await idleAgent(request)
  const leftover = path.join((await apiData<Task>(request, `/tasks/${id}`)).cwd, LEFTOVER)
  fs.writeFileSync(leftover, 'stale\n')
  await request.post(`/api/tasks/${id}/dream`, { data: {} })
  await expect.poll(async () => (await apiData<unknown[]>(request, `/dreams/proposals?task=${id}`)).length).toBe(1)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'Agent settings' }).tap()
  const cleanups = dreams(page).getByRole('list', { name: 'Clean-ups' })
  const allow = cleanups.getByRole('button', { name: 'Allow' })
  await allow.scrollIntoViewIfNeeded()
  await expectTouchTarget(allow)
  await expectFitsPhone(page, 'a clean-up waiting for the user')
  await allow.tap()
  await expect(cleanups).toBeHidden()
  expect(fs.existsSync(leftover)).toBe(false)

  await page.goto('/#settings/storage')
  const restore = page.getByRole('region', { name: 'Trash' }).getByRole('button', { name: `Restore ${leftover}` })
  await restore.scrollIntoViewIfNeeded()
  await expectTouchTarget(restore)
  await expectFitsPhone(page, 'the trash card')
  await restore.tap()
  await expect(restore).toBeHidden()
  expect(fs.existsSync(leftover)).toBe(true)
})
