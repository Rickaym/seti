import { expect, test, toasts, unique } from './support/fixtures.js'
import { newAgentIndex, proposeAsAgent } from './support/knowledge.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('on a phone the user finds proposals from the menu badge and approves or rejects them', async ({
  page,
  request,
}) => {
  const kept = unique('Phone build first')
  const dropped = unique('Phone skip tests')
  await proposeAsAgent(request, kept)
  await proposeAsAgent(request, dropped)

  await page.goto('/#agents')
  await page.getByRole('button', { name: 'Menu' }).click()
  const context = page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Context' })
  await expect(context.locator('[data-section-count]')).toBeVisible()
  await context.click()
  await page.getByRole('region', { name: 'Knowledge' }).getByRole('button').click()
  await expect(page.getByRole('heading', { name: 'Knowledge' })).toBeVisible()
  await expectFitsPhone(page, 'Knowledge proposals')

  const card = page.getByRole('article', { name: `Note: ${kept}` })
  await card.getByRole('button', { name: 'Edit' }).click()
  await expect(card.getByLabel('Note')).toBeVisible()
  await expectFitsPhone(page, 'Knowledge edit')
  await card.getByRole('button', { name: 'Cancel' }).click()
  await card.getByRole('button', { name: 'Approve' }).click()
  await expect(toasts(page).filter({ hasText: 'Approved' })).toBeVisible()
  await page
    .getByRole('article', { name: `Note: ${dropped}` })
    .getByRole('button', { name: 'Reject' })
    .click()
  await expect(toasts(page).filter({ hasText: 'Rejected' })).toBeVisible()

  await page.getByRole('tab', { name: 'Approved' }).click()
  await expect(page.getByRole('article', { name: `Note: ${kept}` })).toBeVisible()
  const index = await newAgentIndex(request)
  expect(index).toContain(kept)
  expect(index).not.toContain(dropped)
})
