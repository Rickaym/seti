import fs from 'node:fs'
import path from 'node:path'
import type { Task } from '@seti/shared'
import { dreams, idleAgent } from './support/dreams.js'
import { LEFTOVER } from './support/fake-dream.js'
import { apiData, expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test.afterEach(async ({ request }) => {
  await request.put('/api/dreams/settings', { data: { cleanups: false } })
})

test('a dream proposes a clean-up, the user allows it, and restores it from the trash', async ({ page, request }) => {
  await page.goto('/#settings/agents')
  const card = page.getByRole('region', { name: 'Dreaming' })
  await card.getByRole('button', { name: 'Propose' }).click()
  await expect(card.getByRole('button', { name: 'Propose' })).toHaveAttribute('aria-pressed', 'true')

  const id = await idleAgent(request)
  const leftover = path.join((await apiData<Task>(request, `/tasks/${id}`)).cwd, LEFTOVER)
  fs.writeFileSync(leftover, 'stale\n')
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'Agent settings' }).click()
  await dreams(page).getByRole('button', { name: 'Dream now' }).click()
  await expect(dreams(page).getByRole('button', { name: 'Last dream' })).toContainText('done')
  const cleanups = dreams(page).getByRole('list', { name: 'Clean-ups' })
  await expect(cleanups).toContainText(leftover)
  await cleanups.getByRole('button', { name: 'Allow' }).click()
  await expect(cleanups).toBeHidden()
  expect(fs.existsSync(leftover)).toBe(false)

  await page.goto('/#settings/storage')
  const trash = page.getByRole('region', { name: 'Trash' })
  await trash.getByRole('button', { name: `Restore ${leftover}` }).click()
  await expect(trash.getByRole('button', { name: `Restore ${leftover}` })).toBeHidden()
  expect(fs.readFileSync(leftover, 'utf8')).toBe('stale\n')
})
