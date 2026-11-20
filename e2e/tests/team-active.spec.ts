import type { Envelope, TeamPosted } from '@seti/shared'
import { expect, nextApiResponse, test } from './support/fixtures.js'
import { activeHint, seedActive } from './support/team-active.js'

test('@active suggests its reach and mentions the agents that worked today', async ({ page, request }) => {
  const seed = await seedActive()
  await page.goto('/#agents')
  await page.keyboard.press('Control+Shift+L')
  const panel = page.getByRole('complementary', { name: 'Group chat' })
  const composer = panel.getByRole('combobox', { name: 'Message the group' })
  await composer.fill('@act')
  const option = panel.getByRole('listbox', { name: 'Mention suggestions' }).getByRole('option').first()
  await expect(option).toContainText('@active')
  await expect(option).toContainText(await activeHint(request))
  await composer.press('Enter')
  await expect(composer).toHaveValue('@active ')

  await composer.pressSequentially('please rebase on main')
  const response = nextApiResponse(page, 'POST', '/team/messages')
  await composer.press('Enter')
  const posted = ((await (await response).json()) as Envelope<TeamPosted>).data
  const reached = posted.deliveries.map((delivery) => delivery.task_id)
  expect(reached).toEqual(expect.arrayContaining(seed.active.map((agent) => agent.id)))
  expect(reached).not.toContain(seed.inactive.id)

  const message = panel.getByTestId('team-message').filter({ hasText: 'please rebase on main' })
  await expect(message.locator('[data-mention="active"]')).toHaveText('@active')
  const reach = message.getByTestId('team-active-reach')
  for (const agent of seed.active) {
    await expect(reach).toContainText(`@${agent.handle}`)
  }
  await expect(reach).not.toContainText(`@${seed.inactive.handle}`)
})
