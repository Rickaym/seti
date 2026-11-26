import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { Task } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'

async function seedAgent(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, unique(title), paths.checkout, new Date().toISOString())
  await db.close()
  return id
}

const reply = (page: Page) => page.getByRole('combobox', { name: 'Reply' })
const card = (page: Page, name: string) => page.getByRole('group', { name: `Command /${name}` })

async function shot(page: Page, name: string): Promise<void> {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' })
}

test('setting commands complete, pick and confirm with taps on a phone', async ({ page, request }) => {
  const id = await seedAgent('Phone commands')
  await page.goto(`/#agents/${id}`)
  await reply(page).tap()
  await reply(page).pressSequentially('/by')
  const list = page.getByRole('listbox', { name: 'Command suggestions' })
  await expect(list.getByRole('option', { name: /\/bypass/ })).toBeVisible()
  await expectFitsPhone(page, 'the command list')
  await shot(page, 'phone-completion')
  await list.getByRole('option', { name: /\/bypass/ }).tap()
  await expect(reply(page)).toHaveValue('/bypass ')

  const bypass = card(page, 'bypass')
  const eight = bypass.getByRole('button', { name: '8 h' })
  await expect(eight).toBeVisible()
  await expectTouchTarget(eight)
  await expectFitsPhone(page, 'the Bypass picker')
  await shot(page, 'phone-picker')
  await eight.tap()
  const turnOn = bypass.getByRole('button', { name: 'Turn on' })
  await expect(turnOn).toBeVisible()
  await expectTouchTarget(turnOn)
  await expectFitsPhone(page, 'the Bypass confirmation')
  await shot(page, 'phone-confirm')
  await turnOn.tap()
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).bypass_until).not.toBeNull()
})

test('a restored /archive waits for Run on a phone', async ({ page, request }) => {
  const id = await seedAgent('Phone restored')
  await page.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value)
    },
    [`seti.draft.task.${id}`, '/archive'] as const,
  )
  await page.goto(`/#agents/${id}`)
  await expect(reply(page)).toHaveValue('/archive')
  await page.getByRole('button', { name: 'Run command' }).tap()
  const archive = card(page, 'archive')
  const run = archive.getByRole('button', { name: 'Run' })
  await expect(run).toBeVisible()
  await expectTouchTarget(run)
  await expectFitsPhone(page, 'the Run card')
  await shot(page, 'phone-run')
  await archive.getByRole('button', { name: 'Cancel' }).tap()
  await expect(archive).toBeHidden()
  expect((await apiData<Task>(request, `/tasks/${id}`)).archived_at).toBeNull()
})
