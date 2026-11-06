import type { Repo } from '@seti/shared'
import { paths } from './support/env.js'
import { apiData, expect, test, toasts, unique } from './support/fixtures.js'

test.use({ allowedHttpStatuses: [400] })

test('add, edit and delete a repo', async ({ page, request }) => {
  const slug = `e2e/${unique('scratch')}`
  const renamed = `${slug}-renamed`
  await page.goto('/#settings/repos')

  await page.getByRole('button', { name: 'Create' }).click()
  const add = page.getByRole('dialog', { name: 'Add repo' })
  await add.getByLabel('GitHub repo').fill('not a slug')
  await add.getByLabel('Local checkout').fill(paths.checkout)
  await add.getByLabel('Base branch').fill('main')
  await add.getByRole('button', { name: 'Save' }).click()
  await expect(toasts(page).filter({ hasText: 'slug must look like owner/name' })).toBeVisible()
  await expect(add).toBeVisible()
  expect((await apiData<Repo[]>(request, '/repos')).map((repo) => repo.slug)).not.toContain('not a slug')

  await add.getByLabel('GitHub repo').fill(slug)
  await add.getByRole('button', { name: 'Save' }).click()
  await expect(add).toBeHidden()
  const row = page.getByRole('row', { name: new RegExp(`${slug} `) })
  await expect(row).toContainText(paths.checkout)

  await row.getByRole('button', { name: 'Edit' }).click()
  const edit = page.getByRole('dialog', { name: 'Edit repo' })
  await expect(edit.getByLabel('GitHub repo')).toHaveValue(slug)
  await edit.getByLabel('GitHub repo').fill(renamed)
  await edit.getByLabel('Base branch').fill('develop')
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(edit).toBeHidden()
  const renamedRow = page.getByRole('row', { name: new RegExp(renamed) })
  await expect(renamedRow).toContainText('develop')
  const saved = (await apiData<Repo[]>(request, '/repos')).find((repo) => repo.slug === renamed)
  expect(saved?.base_branch).toBe('develop')

  await renamedRow.getByRole('button', { name: 'Delete' }).click()
  const confirm = page.getByRole('dialog', { name: 'Confirm' })
  await expect(confirm).toContainText(`Remove ${renamed} from Seti?`)
  await confirm.getByRole('button', { name: 'Confirm' }).click()
  await expect(renamedRow).toBeHidden()
  await expect
    .poll(async () => (await apiData<Repo[]>(request, '/repos')).map((repo) => repo.slug))
    .not.toContain(renamed)
})
