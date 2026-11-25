import { expect, test } from './support/fixtures.js'
import { openReviewer, resetReviewer, reviewer } from './support/role-runtime.js'

test.afterEach(async ({ request }) => {
  await resetReviewer(request)
})

test('a built-in role takes a model, which agents started in it run on, and goes back to any', async ({
  page,
  request,
}) => {
  const picker = await openReviewer(page)
  await expect(picker).toHaveValue('')
  await picker.selectOption({ label: 'Opus' })
  await expect.poll(async () => (await reviewer(request)).model).toBe('opus')
  expect((await reviewer(request)).runtime).toBe('claude')
  await page.reload()
  await expect(page.getByRole('main').getByRole('combobox', { name: 'Runs on' })).toHaveValue('claude:opus')
  await page.getByRole('main').getByRole('combobox', { name: 'Runs on' }).selectOption({ label: 'Any model' })
  await expect.poll(async () => (await reviewer(request)).runtime).toBeNull()
})
