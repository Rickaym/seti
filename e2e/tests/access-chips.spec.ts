import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import { openAgentSettings } from './support/agent-settings.js'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

const ROLE = 'arn:aws:iam::123456789012:role/e2e-chips'

async function seedTask(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, title, paths.checkout, new Date().toISOString())
  await db.close()
  return id
}

const colourOf = async (page: Page, className: string) =>
  page.evaluate((name) => {
    const probe = document.createElement('span')
    probe.className = name
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, className)

const colour = async (chip: Locator) => chip.evaluate((element) => getComputedStyle(element).color)

test('access that is off reads muted, never red, and on reads normal', async ({ page, request }) => {
  const id = await seedTask(`E2E chips ${randomUUID().slice(0, 6)}`)
  const created = await request.post('/api/credentials/profiles', { data: { name: `E2E chips ${id.slice(0, 6)}` } })
  const set = ((await created.json()) as { data: { id: string } }).data
  const role = { role_arn: ROLE, external_id: null, region: 'us-east-1', session_minutes: 60 }
  expect((await request.put(`/api/credentials/profiles/${set.id}/aws`, { data: role })).ok()).toBe(true)
  expect((await request.patch(`/api/tasks/${id}`, { data: { profile_id: set.id } })).ok()).toBe(true)
  const off = { kind: 'aws', id: 'aws', enabled: false }
  expect((await request.put(`/api/tasks/${id}/access`, { data: off })).ok()).toBe(true)
  await page.goto(`/#agents/${id}`)
  await openAgentSettings(page, 'Access')
  const chips = page.getByRole('list', { name: 'Access' })
  const aws = chips.getByRole('listitem').filter({ hasText: 'AWS' }).locator('[data-state]')
  await expect(aws).toHaveAttribute('data-state', 'off')

  const muted = await colourOf(page, 'text-muted-foreground')
  const red = await colourOf(page, 'text-destructive')
  for (const chip of await chips.locator('[data-state="off"]').all()) {
    expect(await colour(chip)).toBe(muted)
    expect(await colour(chip)).not.toBe(red)
  }

  await page.getByRole('button', { name: 'Edit access' }).click()
  const access = page.getByRole('dialog', { name: /^Access of / })
  await access.getByRole('region', { name: 'AWS' }).getByRole('switch', { name: 'AWS' }).click()
  await page.keyboard.press('Escape')
  await openAgentSettings(page, 'Access')
  await expect(aws).toHaveAttribute('data-state', 'on')
  expect(await colour(aws)).toBe(await colourOf(page, 'text-foreground'))
  expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
  expect((await request.delete(`/api/credentials/profiles/${set.id}`)).ok()).toBe(true)
})
