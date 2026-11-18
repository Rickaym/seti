import { fakeGhEnv } from './support/fake-gh-env.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { expectOwnCommentQuiet, seedCommenter } from './support/pr-quiet.js'

test.use({ serverEnv: fakeGhEnv() })

test('marks an update Seti only recorded on a phone, beside the one that waits for the agent', async ({ page }) => {
  const id = await seedCommenter('Phone quiet updates')
  await page.goto(`/#agents/${id}`)
  await expect(page.getByRole('main').getByRole('heading', { name: 'Phone quiet updates' })).toBeVisible()
  await expectOwnCommentQuiet(page)
  await expectFitsPhone(page, 'quiet PR updates in the transcript')
})
