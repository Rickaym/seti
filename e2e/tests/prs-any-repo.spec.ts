import { expect, test } from './support/fixtures.js'
import { ANY_REPO_ENV, expectListedWithoutRepos, seedAnyRepoPrs } from './support/prs-any-repo.js'

test.use({ serverEnv: ANY_REPO_ENV })

test('a PR in a repo Seti has no checkout of shows its status, takes Fix CI and can be linked', async ({
  page,
  request,
}) => {
  const seeded = await seedAnyRepoPrs(request, 'E2E any repo')
  const { agent, linked, authored } = seeded
  await page.goto(`/#agents/${agent.id}`)
  const main = page.getByRole('main')
  const chip = main.getByRole('group', { name: `Pull request ${linked.label}` })
  const link = chip.getByRole('link', { name: linked.label })
  await expect(link).toHaveAttribute('title', linked.title)
  await expect(link).toHaveAttribute('href', linked.url)
  await expect(chip.getByRole('img', { name: '1 unresolved review thread' })).toBeVisible()
  await expectListedWithoutRepos(request, seeded)

  await main.getByRole('button', { name: 'Link PR' }).click()
  const picker = page.getByRole('dialog')
  await expect(picker.getByPlaceholder('Search open PRs')).toBeVisible()
  await picker.getByLabel('Search pull requests').fill(authored.slug)
  const choice = picker.getByRole('button', { name: new RegExp(authored.title) })
  await expect(choice).toContainText('ci pass')
  await choice.click()
  await expect(picker).toBeHidden()
  const added = main.getByRole('group', { name: `Pull request ${authored.label}` })
  await expect(added).toContainText('ci pass')
  await expect(added.getByRole('link', { name: authored.label })).toHaveAttribute('title', authored.title)

  await main.getByRole('button', { name: `Failing checks of ${linked.label}` }).click()
  const checks = page.getByRole('dialog')
  await expect(checks.getByTestId('failing-check')).toContainText('build')
  await checks.getByRole('button', { name: 'Fix CI' }).click()
  await expect(checks).toBeHidden()
  await expect(page.getByText(`Asked ${agent.title} to fix CI on #3`)).toBeVisible()
  const sent = page.getByRole('region', { name: 'Transcript' }).locator('[data-own-message]')
  await expect(sent.filter({ hasText: 'CI is failing on #3. Please fix it.' })).toHaveCount(1)
})
