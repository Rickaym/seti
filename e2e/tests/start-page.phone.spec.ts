import fs from 'node:fs'
import type { Task } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

const TARGET_PX = 40

test('a phone starts an agent from one message, with nothing else to pick', async ({ page, request }) => {
  await page.goto('/#agents/new')
  const main = page.getByRole('main')
  const message = page.getByLabel('Message')
  await expect(message).toBeEditable()
  await expect(main.getByText('It works in its own folder and clones what it needs.')).toBeVisible()
  await expect(page.getByRole('group', { name: 'Recent repos' })).toHaveCount(0)
  await expect(main.locator('select')).toHaveCount(0)
  await expectFitsPhone(page, 'the start page')

  const start = main.getByRole('button', { name: 'Start agent' })
  await expect(start).toBeDisabled()
  await message.fill('planner down: tidy the notes from the phone')
  const box = await start.boundingBox()
  expect(Math.min(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(TARGET_PX)
  await start.tap()
  await expect(page).toHaveURL(/#agents\/[\da-f-]{36}$/)
  const id = new URL(page.url()).hash.split('/')[1] ?? ''
  const task = await apiData<Task>(request, `/tasks/${id}`)
  expect(task).toMatchObject({ repos: [], dirs: [], home_access: false })
  expect(fs.statSync(task.cwd).isDirectory()).toBe(true)
  await page.goto('/#agents')
  expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
})
