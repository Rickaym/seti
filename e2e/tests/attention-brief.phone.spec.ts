import { awayWhile, BRIEF_ENV, briefToast, finishedAgent, waitingBrief } from './support/attention.js'
import { expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test.use({ serverEnv: BRIEF_ENV })

const BRIEF_MS = 15_000

test('on a phone the brief fits, a tap opens the agent, and Close drops it', async ({ page, request }) => {
  test.setTimeout(90_000)
  await page.goto('/#agents')
  await expect(page.getByRole('main')).toBeVisible()
  const doneTitle = unique('Phone brief')
  const askTitle = unique('Phone asks')
  let done = ''
  await awayWhile(page, async () => {
    done = await finishedAgent(request, doneTitle)
    await finishedAgent(request, askTitle, true)
  })

  const brief = briefToast(page)
  await expect(brief).toBeVisible({ timeout: BRIEF_MS })
  await expect(brief.getByRole('button').filter({ hasText: askTitle })).toBeVisible()
  await expectFitsPhone(page, 'since-you-left brief')
  const toast = page.locator('[data-sonner-toast]').filter({ has: brief })
  await toast.screenshot({ path: test.info().outputPath('brief.png') })

  await brief.getByRole('button').filter({ hasText: doneTitle }).tap()
  await expect(page).toHaveURL(new RegExp(`#agents/${done}$`))
  await toast.getByRole('button', { name: 'Close toast' }).tap()
  await expect(brief).toBeHidden()
  await expect.poll(async () => waitingBrief(request)).toBeNull()
})
