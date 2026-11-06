import { awayWhile, BRIEF_ENV, briefToast, finishedAgent, waitingBrief } from './support/attention.js'
import { EA_HEADERS } from './support/env.js'
import { expect, test, unique } from './support/fixtures.js'

test.use({ serverEnv: BRIEF_ENV })

/** The brief reaches the page at its next poll of attention, at most ten seconds on. */
const BRIEF_MS = 15_000

test('coming back after being away shows one brief: needs-you first, then what finished', async ({ page, request }) => {
  test.setTimeout(90_000)
  await page.goto('/#context')
  await expect(page.getByRole('main')).toBeVisible()
  const doneTitle = unique('Brief finished')
  const askTitle = unique('Brief asks')
  let done = ''
  await awayWhile(page, async () => {
    done = await finishedAgent(request, doneTitle)
    await finishedAgent(request, askTitle, true)
  })

  const brief = briefToast(page)
  await expect(brief).toBeVisible({ timeout: BRIEF_MS })
  await expect(brief).toContainText('agent finished')
  await expect(brief).toContainText('needs you')
  const lines = brief.getByRole('button')
  await expect(lines.filter({ hasText: askTitle })).toContainText('Asks:')
  await expect(lines.filter({ hasText: doneTitle })).toContainText('done')
  const text = await brief.innerText()
  expect(text.indexOf(askTitle)).toBeLessThan(text.indexOf(doneTitle))
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: doneTitle })).toHaveCount(1)

  await lines.filter({ hasText: doneTitle }).click()
  await expect(page).toHaveURL(new RegExp(`#agents/${done}$`))
  await expect(brief).toBeVisible()

  await page.locator('[data-sonner-toast]').filter({ has: brief }).getByRole('button', { name: 'Close toast' }).click()
  await expect(brief).toBeHidden()
  await expect.poll(async () => waitingBrief(request)).toBeNull()
})

test('the EA takes the brief for a call, so the page no longer shows it', async ({ page, request }) => {
  test.setTimeout(60_000)
  await page.goto('/#context')
  await awayWhile(page, async () => {
    await finishedAgent(request, unique('Told on a call'))
  })
  await expect(briefToast(page)).toBeVisible({ timeout: BRIEF_MS })
  const told = await request.get('/api/ea/brief', { headers: EA_HEADERS })
  expect(((await told.json()) as { data: { brief: { summary: string } } }).data.brief.summary).toContain(
    'One agent finished',
  )
  await expect(briefToast(page)).toBeHidden({ timeout: BRIEF_MS })
})
