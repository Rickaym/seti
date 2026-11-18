import { fakeGhEnv } from './support/fake-gh-env.js'
import { expect, test } from './support/fixtures.js'
import { expectOwnCommentQuiet, seedCommenter } from './support/pr-quiet.js'

test.use({ serverEnv: fakeGhEnv() })

test('records the comment an agent posted itself and hands it only the one someone else wrote', async ({ page }) => {
  const id = await seedCommenter('E2E quiet updates')
  await page.goto(`/#agents/${id}`)
  await expect(page.getByRole('main').getByRole('group', { name: 'Pull request web#5' })).toBeVisible()
  await expectOwnCommentQuiet(page)
  const badge = page.getByRole('main').locator('[data-quiet="own_action"]')
  await expect(badge).toHaveAttribute('title', /did this itself/)
})
