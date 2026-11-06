import { expect, test } from './support/fixtures.js'
import { setModEnabled } from './support/mods.js'
import { expectTwemoji, markPage, samePage, seedEmojiAgent, switchTwemoji } from './support/twemoji.js'

test.afterEach(async ({ request }) => {
  await setModEnabled(request, 'twemoji', true)
})

test('on a phone, Twemoji draws emoji in the transcript, composer and Markdown, and toggles live', async ({ page }) => {
  const id = await seedEmojiAgent()
  await page.goto(`/#agents/${id}`)
  await markPage(page)
  await expectTwemoji(page, true)

  await switchTwemoji(page, id, false)
  await expectTwemoji(page, false)

  await switchTwemoji(page, id, true)
  await expectTwemoji(page, true)
  expect(await samePage(page)).toBe(true)
})
