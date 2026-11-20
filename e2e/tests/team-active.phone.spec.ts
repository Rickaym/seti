import { expect, test } from './support/fixtures.js'
import { activeHint, seedActive } from './support/team-active.js'

test('@active works from the phone sheet and reaches only the agents that ran a turn today', async ({
  page,
  request,
}) => {
  const seed = await seedActive()
  await page.goto('/#agents')
  await page.getByRole('banner').getByTestId('team-chat-toggle').tap()
  const sheet = page.getByRole('dialog', { name: 'Group chat' })
  const composer = sheet.getByRole('combobox', { name: 'Message the group' })
  await composer.fill('@acti')
  const option = sheet.getByRole('listbox', { name: 'Mention suggestions' }).getByRole('option', { name: /^@active/ })
  await expect(option).toContainText(await activeHint(request))
  await option.tap()
  await expect(composer).toHaveValue('@active ')
  await composer.pressSequentially('standup in five')
  await sheet.getByRole('button', { name: 'Send to the group' }).tap()
  await expect(composer).toHaveValue('')
  const status = sheet.getByRole('status', { name: 'Group chat status' })
  await expect(status).toContainText('Posted: started')
  for (const handle of seed.today) {
    await expect(status).toContainText(`@${handle}`)
  }
  await expect(status).not.toContainText(`@${seed.stale}`)
})
