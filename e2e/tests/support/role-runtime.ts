import type { APIRequestContext, Page } from '@playwright/test'
import { BUILTIN_ROLES, type ContextPack } from '@seti/shared'
import { apiData, expect } from './fixtures.js'

const REVIEWER = BUILTIN_ROLES.find((role) => role.name === 'Reviewer')?.id ?? ''

/** The built-in Reviewer as Seti serves it. */
export async function reviewer(request: APIRequestContext): Promise<ContextPack> {
  const found = (await apiData<ContextPack[]>(request, '/context/packs')).find((pack) => pack.id === REVIEWER)
  if (found === undefined) {
    throw new Error('Seti serves no built-in Reviewer')
  }
  return found
}

/** Opens the built-in Reviewer role on the Context page and returns its "Runs on" picker. */
export async function openReviewer(page: Page) {
  await page.goto('/#context')
  await page
    .getByRole('region', { name: 'Roles' })
    .getByRole('button', { name: /^Reviewer Built in/ })
    .click()
  const picker = page.getByRole('main').getByRole('combobox', { name: 'Runs on' })
  await expect(picker).toBeVisible()
  return picker
}

/** Puts the Reviewer back on any model, so other specs see it as Seti ships it. */
export async function resetReviewer(request: APIRequestContext): Promise<void> {
  await request.put(`/api/context/packs/${REVIEWER}/runtime`, { data: { runtime: null, model: null } })
}
