import { expect, test } from './support/fixtures.js'
import { openAgentPrs } from './support/phone-agent.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { expectNoFixCiToast, ownMessages } from './support/pr-ci.js'
import { ANY_REPO_ENV, expectListedWithoutRepos, seedAnyRepoPrs } from './support/prs-any-repo.js'

test.use({ serverEnv: ANY_REPO_ENV })

test('the phone sheet shows a PR of a repo Seti has no checkout of in full, with Fix CI', async ({ page, request }) => {
  const seeded = await seedAnyRepoPrs(request, 'Phone any repo')
  const { agent, linked } = seeded
  await page.goto(`/#agents/${agent.id}`)
  const sheet = await openAgentPrs(page)
  const row = sheet.getByRole('listitem', { name: `Pull request ${linked.label}` })
  await expect(row).toContainText(linked.title)
  await expect(row).toContainText(`${linked.slug}#3`)
  await expect(row.getByRole('link', { name: new RegExp(linked.title) })).toHaveAttribute('href', linked.url)
  await expect(row.getByTestId('failing-check')).toContainText('build')
  await expectFitsPhone(page, 'linked PR of a repo without a checkout')
  await expectListedWithoutRepos(request, seeded)
  await row.getByRole('button', { name: 'Fix CI' }).tap()
  await expect(sheet).toBeHidden()
  await expect(ownMessages(page, 'CI is failing on #3. Please fix it.')).toHaveCount(1)
  await expectNoFixCiToast(page)
  await expectFitsPhone(page, 'agent after Fix CI')
})
