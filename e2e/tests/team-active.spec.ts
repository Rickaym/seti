import { expect, test } from './support/fixtures.js'
import { activeHint, seedActive } from './support/team-active.js'

test('@active suggests itself with a count and reaches only the agents that ran a turn today', async ({
  page,
  request,
}) => {
  const seed = await seedActive()
  await page.goto('/#agents')
  await page.keyboard.press('Control+Shift+L')
  const panel = page.getByRole('complementary', { name: 'Group chat' })
  const composer = panel.getByRole('combobox', { name: 'Message the group' })
  await composer.fill('@acti')
  const option = panel.getByRole('listbox', { name: 'Mention suggestions' }).getByRole('option', { name: /^@active/ })
  await expect(option).toContainText(await activeHint(request))
  await composer.press('Enter')
  await expect(composer).toHaveValue('@active ')
  await composer.pressSequentially('standup in five')
  await composer.press('Enter')
  await expect(composer).toHaveValue('')
  const status = panel.getByRole('status', { name: 'Group chat status' })
  await expect(status).toContainText('Posted: started')
  for (const handle of seed.today) {
    await expect(status).toContainText(`@${handle}`)
  }
  await expect(status).not.toContainText(`@${seed.stale}`)
})
