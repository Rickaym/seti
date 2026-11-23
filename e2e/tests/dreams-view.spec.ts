import fs from 'node:fs'
import path from 'node:path'
import type { Task } from '@seti/shared'
import { idleAgent } from './support/dreams.js'
import { DREAM_SUMMARY, LEFTOVER } from './support/fake-dream.js'
import { apiData, expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test.afterEach(async ({ request }) => {
  await request.put('/api/dreams/settings', { data: { cleanups: false } })
})

test('the Dreams view puts what wants you first and opens the agent', async ({ page, request }) => {
  await request.put('/api/dreams/settings', { data: { cleanups: true } })
  const id = await idleAgent(request)
  fs.writeFileSync(path.join((await apiData<Task>(request, `/tasks/${id}`)).cwd, LEFTOVER), 'stale\n')
  await request.post(`/api/tasks/${id}/dream`, { data: {} })
  await expect.poll(async () => (await apiData<unknown[]>(request, `/dreams/proposals?task=${id}`)).length).toBe(1)
  await page.goto('/#dreaming.dreams')
  const wants = page.getByRole('region', { name: 'Wants you' })
  await expect(wants).toContainText(LEFTOVER)
  await expect(page.getByRole('region', { name: 'Agents' })).toContainText(DREAM_SUMMARY)
  await wants.getByRole('button', { name: 'Open' }).click()
  await expect(page).toHaveURL(new RegExp(`#agents/${id}`))
})
