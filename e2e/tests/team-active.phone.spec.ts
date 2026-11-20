import type { Envelope, TeamPosted } from '@seti/shared'
import { expect, nextApiResponse, test } from './support/fixtures.js'
import { activeHint, seedActive } from './support/team-active.js'

test('@active suggests its reach and mentions the agents that worked today on a phone', async ({ page, request }) => {
  const seed = await seedActive()
  await page.goto('/#agents')
  await page.getByRole('banner').getByTestId('team-chat-toggle').tap()
  const sheet = page.getByRole('dialog', { name: 'Group chat' })
  const composer = sheet.getByRole('combobox', { name: 'Message the group' })
  await composer.fill('@act')
  const option = sheet.getByRole('listbox', { name: 'Mention suggestions' }).getByRole('option').first()
  await expect(option).toContainText('@active')
  await expect(option).toContainText(await activeHint(request))
  await option.tap()
  await expect(composer).toHaveValue('@active ')

  await composer.pressSequentially('phone check')
  const response = nextApiResponse(page, 'POST', '/team/messages')
  await sheet.getByRole('button', { name: 'Send to the group' }).tap()
  const posted = ((await (await response).json()) as Envelope<TeamPosted>).data
  const reached = posted.deliveries.map((delivery) => delivery.task_id)
  expect(reached).toEqual(expect.arrayContaining(seed.active.map((agent) => agent.id)))
  expect(reached).not.toContain(seed.inactive.id)

  const reach = sheet.getByTestId('team-message').filter({ hasText: 'phone check' }).getByTestId('team-active-reach')
  await expect(reach).toContainText(`@${seed.active[0].handle}`)
  await expect(reach).not.toContainText(`@${seed.inactive.handle}`)
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(scroll).toBe(0)
})
