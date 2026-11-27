import { fakeEaPrompt } from './support/ea-prompt.js'
import { expect, test } from './support/fixtures.js'

test('the EA prompt starts closed, opens a part on a click, copies it and searches', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await fakeEaPrompt(page)
  await page.goto('/#settings/ea')
  const card = page.getByRole('main').getByRole('region', { name: 'Prompt' })
  await expect(card.getByTestId('ea-prompt-size')).toHaveText(/^\d{2},\d{3} characters in 5 parts; build 0123456$/)
  await expect(card).toContainText('Read only: the prompt changes through code, measured in simulation.')
  for (const name of ['Base prompt', 'Call note', 'Chat note', 'Inbox note', 'Live context']) {
    await expect(card.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveAttribute('aria-expanded', 'false')
  }
  expect((await card.boundingBox())?.height).toBeLessThan(500)

  await card.getByRole('button', { name: /^Live context/ }).click()
  const live = card.getByRole('region', { name: 'Live context' })
  await expect(live).toContainText('Changes every turn.')
  await expect(live).toContainText('Sent 2m ago.')
  await expect(live.locator('pre')).toContainText('Atlas: fix the login redirect')
  await live.getByRole('button', { name: 'Copy live context' }).click()
  expect(await page.evaluate(async () => navigator.clipboard.readText())).toContain('Tasks: 3 in all; 1 running.')

  await card.getByRole('button', { name: /^Base prompt/ }).click()
  const base = card.getByRole('region', { name: 'Base prompt' })
  expect((await base.locator('pre').boundingBox())?.height).toBeLessThan(700)

  const search = card.getByRole('searchbox', { name: 'Search prompt' })
  await search.fill('chat reply style')
  await expect(card.getByRole('button', { name: /^Chat note/ })).toHaveAttribute('aria-expanded', 'true')
  await expect(card.getByRole('button', { name: /^Chat note/ })).toContainText('1 found')
  await expect(card.getByRole('button', { name: /^Base prompt/ })).toHaveAttribute('aria-expanded', 'false')
  await expect(card.locator('mark')).toHaveCount(1)
  await search.fill('')
  await expect(card.getByRole('button', { name: /^Chat note/ })).toHaveAttribute('aria-expanded', 'false')
  await expect(card.getByRole('button', { name: /^Base prompt/ })).toHaveAttribute('aria-expanded', 'true')
})

test('the EA prompt says plainly when the EA is not running', async ({ page }) => {
  await page.goto('/#settings/ea')
  const card = page.getByRole('main').getByRole('region', { name: 'Prompt' })
  await expect(card).toContainText('The EA is not running, so it cannot show its prompt.')
  await expect(card.getByRole('searchbox')).toHaveCount(0)
})
