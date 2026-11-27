import { fakeEaTools } from './support/ea-tools.js'
import { expect, test } from './support/fixtures.js'

test('the EA settings list its tools by area, with which ask first, and find one by search', async ({ page }) => {
  await fakeEaTools(page)
  await page.goto('/#settings/ea')
  const card = page.getByRole('main').getByRole('region', { name: 'Tools' })
  await expect(card.getByTestId('ea-tools-count')).toHaveText('5 tools; 2 ask first; 1 on your word')
  await expect(card).toContainText('no tools for secret values, credentials, connections, share links or sign-in')
  await expect(card.getByRole('region', { name: 'Agents' }).getByRole('listitem')).toHaveCount(2)
  const stop = card.getByRole('listitem').filter({ hasText: 'stop_task' })
  await expect(stop).toContainText('Stop the running turn of one task.')
  await stop.getByText('Asks first').hover()
  await expect(page.getByRole('tooltip')).toContainText('waits for your yes')
  await expect(card.getByRole('listitem').filter({ hasText: 'list_tasks' })).not.toContainText('Asks first')

  const search = card.getByRole('searchbox', { name: 'Search tools' })
  await search.fill('on your word')
  await expect(card.getByRole('listitem')).toHaveCount(1)
  await expect(card.getByRole('listitem')).toContainText('answer_question')
  await search.fill('nothing like this')
  await expect(card).toContainText('No tool matches.')
})

test('the EA tool list says plainly when the EA is not running', async ({ page }) => {
  await page.goto('/#settings/ea')
  const card = page.getByRole('main').getByRole('region', { name: 'Tools' })
  await expect(card).toContainText('The EA is not running, so it cannot list its tools.')
  await expect(card.getByRole('searchbox')).toHaveCount(0)
})
