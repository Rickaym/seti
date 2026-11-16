import { expect, test } from './support/fixtures.js'
import { prUrl } from './support/pr-ci.js'
import { lazyList, lazyRow, mockLazyDetails, mockLists, seedIdleAgent } from './support/pr-lazy.js'

const byNumber = (a: string, b: string) => Number(a.split('/').at(-1)) - Number(b.split('/').at(-1))

const urlsOf = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, n) => prUrl('e2e/lazy', from + n))

test('the picker mounts rows in batches and loads detail only for the rows it mounted', async ({ page }) => {
  await mockLists(page, [lazyList(60)])
  const asked = await mockLazyDetails(page)
  const id = await seedIdleAgent('E2E lazy picker')
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'Link PR' }).click()
  const picker = page.getByRole('dialog')
  const rows = picker.getByRole('listitem').getByRole('button')

  await expect(rows).toHaveCount(20)
  await expect(rows.first().getByRole('img', { name: '2 unresolved review threads' })).toBeVisible()
  expect(asked.map((urls) => urls.toSorted(byNumber))).toEqual([urlsOf(1, 20)])

  await rows.last().scrollIntoViewIfNeeded()
  await picker.getByRole('list').evaluate((list) => {
    list.scrollTo(0, list.scrollHeight)
  })
  await expect(rows).toHaveCount(40)
  await expect.poll(() => asked.length).toBe(2)
  expect(asked[1]?.toSorted(byNumber)).toEqual(urlsOf(21, 40))

  await picker.getByLabel('Search pull requests').fill('lazy change 57')
  await expect(rows).toHaveCount(1)
  await expect(rows.first().getByRole('img', { name: '2 unresolved review threads' })).toBeVisible()
  expect(asked.at(-1)).toEqual([prUrl('e2e/lazy', 57)])
  await page.request.delete(`/api/tasks/${id}`)
})

test('the picker shows the last known list at once, says it is refreshing, then shows the new one', async ({
  page,
}) => {
  const fresh = { ...lazyRow(9), title: 'Opened a minute ago' }
  await mockLists(page, [lazyList(2, { refreshing: true }), lazyList(2, { prs: [fresh, lazyRow(1), lazyRow(2)] })])
  await mockLazyDetails(page)
  const id = await seedIdleAgent('E2E refreshing picker')
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'Link PR' }).click()
  const picker = page.getByRole('dialog')
  await expect(picker.getByRole('listitem').getByRole('button')).toHaveCount(2)
  await expect(picker.getByText('Refreshing from GitHub')).toBeVisible()
  await expect(picker.getByRole('button', { name: /Opened a minute ago/ })).toBeVisible({ timeout: 10_000 })
  await expect(picker.getByText('Refreshing from GitHub')).toBeHidden()
  await page.request.delete(`/api/tasks/${id}`)
})
