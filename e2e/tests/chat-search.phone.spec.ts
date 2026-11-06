import { NEEDLE_TURNS, seedLongTranscript } from './support/chat-search.js'
import { expect, test, unique } from './support/fixtures.js'

test('finds far back in a transcript from the actions sheet on a phone', async ({ page }) => {
  test.setTimeout(60_000)
  const needle = unique('larkspur')
  const id = await seedLongTranscript(unique('Phone search'), needle)
  await page.goto(`/#agents/${id}`)
  const transcript = page.getByRole('region', { name: 'Transcript' })
  await expect(transcript.getByText('Reply 3000 done')).toBeVisible()

  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Find in this chat' }).tap()
  const field = page.getByTestId('chat-find-input')
  await expect(field).toBeFocused()
  await field.fill(needle)
  await expect(page.getByTestId('chat-find-count')).toHaveText('1 of 3')
  await page.getByRole('button', { name: 'Older match' }).tap()
  await page.getByRole('button', { name: 'Older match' }).tap()
  const hit = page.locator('[data-find-current]')
  await expect(hit).toContainText(`Reply ${String(NEEDLE_TURNS[2])} found the ${needle} here`)
  await expect(hit).toBeInViewport()
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(scroll).toBe(0)

  await page.getByRole('button', { name: 'Close find' }).tap()
  await expect(page.getByTestId('chat-find')).toBeHidden()
  await expect(transcript.getByText('Reply 3000 done')).toBeInViewport()
})
