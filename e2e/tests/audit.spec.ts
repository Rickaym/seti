import type { Repo } from '@seti/shared'
import { paths } from './support/env.js'
import { apiData, expect, test, unique } from './support/fixtures.js'

test('adding a repo shows up in the audit log and filters by area', async ({ page, request }) => {
  const slug = `e2e/${unique('audited')}`
  await page.goto('/#settings/repos')
  await page.getByRole('button', { name: 'Create' }).click()
  const add = page.getByRole('dialog', { name: 'Add repo' })
  await add.getByLabel('GitHub repo').fill(slug)
  await add.getByLabel('Local checkout').fill(paths.checkout)
  await add.getByLabel('Base branch').fill('main')
  await add.getByRole('button', { name: 'Save' }).click()
  await expect(add).toBeHidden()

  await page.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Audit log' }).click()
  await expect(page).toHaveURL(/#settings\/audit$/)
  const main = page.getByRole('main')
  await expect(main.getByRole('status', { name: 'Audit chain intact' })).toHaveText('Chain intact')
  await expect(main).toContainText('Kept for 365 days.')
  const added = main.getByRole('row').filter({ hasText: `Added repo ${slug}` })
  await expect(added).toContainText('repo.added')
  await expect(added).toContainText('user')
  await expect(added.getByRole('link', { name: 'Repos' })).toHaveAttribute('href', '#settings/repos')

  await main.getByRole('combobox', { name: 'Area' }).click()
  await page.getByRole('option', { name: 'Repos' }).click()
  await expect(page).toHaveURL(/#settings\/audit\/repo$/)
  await expect(added).toBeVisible()
  await expect(main.locator('tr[data-kind="system.started"]')).toHaveCount(0)
  const kinds = await main.locator('tbody tr').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-kind')))
  expect(kinds.every((kind) => kind?.startsWith('repo.') === true)).toBe(true)

  await main.getByRole('combobox', { name: 'Area' }).click()
  await page.getByRole('option', { name: 'Agents' }).click()
  await expect(added).toBeHidden()

  await main.getByRole('combobox', { name: 'Area' }).click()
  await page.getByRole('option', { name: 'All areas' }).click()
  await expect(page).toHaveURL(/#settings\/audit$/)
  await main.getByLabel('Search audit log').fill(slug)
  await expect(added).toBeVisible()
  await expect(main.locator('tbody tr')).toHaveCount(1)

  const repo = (await apiData<Repo[]>(request, '/repos')).find((r) => r.slug === slug)
  expect(repo).toBeDefined()
  if (repo) {
    expect((await request.delete(`/api/repos/${repo.id}`)).ok()).toBe(true)
  }
})
