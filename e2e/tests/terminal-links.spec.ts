import { expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { run, screenOf, terminalButton, terminalIn } from './support/terminal.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const LINK = 'https://example.com/seti-desk'

test('a link printed in the terminal opens in a new tab on click', async ({ page, context }) => {
  await context.route('https://example.com/**', async (route) => route.fulfill({ body: 'docs' }))
  await page.goto('/#settings')
  await terminalButton(page).click()
  const terminal = terminalIn(page)
  await run(terminal, `clear; echo see ${LINK} now`)
  const row = screenOf(terminal)
    .locator('> div')
    .filter({ hasText: /^see https/u })
  await expect(row).toBeVisible()
  const text = row.locator('span').first()
  const box = (await text.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 }
  const cell = box.width / ((await text.textContent()) ?? ' ').length
  const at = { x: box.x + cell * 10, y: box.y + box.height / 2 }

  const opened = page.waitForEvent('popup')
  await page.mouse.move(at.x, at.y)
  await page.mouse.click(at.x, at.y)
  await expect(await opened).toHaveURL(LINK)
})
