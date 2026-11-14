import type { Page } from '@playwright/test'
import { NEEDLE_TURNS, seedLongTranscript, seedTeamNotes, TOOL_TURN } from './support/chat-search.js'
import { expect, test, unique } from './support/fixtures.js'

const transcript = (page: Page) => page.getByRole('region', { name: 'Transcript' })
const findBar = (page: Page) => page.getByTestId('chat-find')
const current = (page: Page) => page.locator('[data-find-current]')
const reply = (turn: number, needle: string) => `Reply ${String(turn)} found the ${needle} here`

/** Whether a Ctrl+F keydown reached the browser untouched, so its own find would run. */
const browserFindKept = async (page: Page) =>
  page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })),
  )

test('finds a message far back in a long transcript, steps through hits and returns to the latest', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const needle = unique('zephyrine')
  const title = unique('Long search')
  const id = await seedLongTranscript(title, needle)
  const transcriptRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === `/api/tasks/${id}/messages`) {
      transcriptRequests.push(url.search)
    }
  })
  await page.goto(`/#agents/${id}`)
  await expect(transcript(page).getByText('Reply 3000 done')).toBeVisible()

  await page.keyboard.press('Control+f')
  await expect(findBar(page)).toBeVisible()
  await expect(page.getByTestId('chat-find-input')).toBeFocused()
  await page.keyboard.type(needle)
  await expect(page.getByTestId('chat-find-count')).toHaveText('1 of 3')
  await expect(current(page)).toContainText(reply(NEEDLE_TURNS[0], needle))
  expect(transcriptRequests).toEqual([])

  await page.keyboard.press('Enter')
  await expect(page.getByTestId('chat-find-count')).toHaveText('2 of 3')
  await expect(current(page)).toContainText(reply(NEEDLE_TURNS[1], needle))
  await expect(current(page)).toBeInViewport()
  await expect(page.getByTestId('back-to-latest')).toBeVisible()
  await expect(transcript(page).getByRole('button', { name: 'Load later' })).toBeAttached()

  await page.getByRole('button', { name: 'Older match' }).click()
  await expect(page.getByTestId('chat-find-count')).toHaveText('3 of 3')
  await expect(current(page)).toContainText(reply(NEEDLE_TURNS[2], needle))
  await expect(current(page)).toBeInViewport()

  await page.keyboard.press('Shift+Enter')
  await expect(current(page)).toContainText(reply(NEEDLE_TURNS[1], needle))
  expect(transcriptRequests.every((search) => search.includes('around=') || search.includes('before='))).toBe(true)
  expect(await transcript(page).locator('[data-message-id]').count()).toBeLessThan(400)

  await page.keyboard.press('Escape')
  await expect(findBar(page)).toBeHidden()
  await expect(page.getByTestId('back-to-latest')).toHaveCount(0)
  await expect(transcript(page).getByText('Reply 3000 done')).toBeInViewport()
})

test('finds messages and replies by default, and tool calls and output far back once Tools is on', async ({ page }) => {
  test.setTimeout(60_000)
  const needle = unique('larkspur')
  const id = await seedLongTranscript(unique('Tools search'), needle, true)
  await page.goto(`/#agents/${id}`)
  await expect(transcript(page).getByText('Reply 3000 done')).toBeVisible()
  await page.keyboard.press('Control+f')
  await page.keyboard.type(needle)
  const count = page.getByTestId('chat-find-count')
  const tools = findBar(page).getByRole('button', { name: 'Tools' })
  await expect(count).toHaveText('1 of 3')
  await expect(tools).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Enter')
  await expect(count).toHaveText('2 of 3')
  await page.keyboard.press('Enter')
  await expect(count).toHaveText('3 of 3')
  await expect(current(page)).toContainText(reply(NEEDLE_TURNS[2], needle))

  await tools.click()
  await expect(tools).toHaveAttribute('aria-pressed', 'true')
  await expect(count).toHaveText('1 of 5')
  await expect(current(page)).toContainText(reply(NEEDLE_TURNS[0], needle))
  const older = page.getByRole('button', { name: 'Older match' })
  await older.click()
  await expect(count).toHaveText('2 of 5')
  await older.click()
  await expect(count).toHaveText('3 of 5')
  await expect(current(page)).toContainText(`${needle} from the tool`)
  await expect(current(page).getByText(`${needle} from the tool`)).toBeInViewport()
  await expect(transcript(page).getByText(`Reply ${String(TOOL_TURN)} done`)).toBeAttached()
  await older.click()
  await expect(count).toHaveText('4 of 5')
  await expect(current(page)).toContainText(`echo ${needle}`)
  await older.click()
  await expect(count).toHaveText('5 of 5')
  await expect(current(page)).toContainText(reply(NEEDLE_TURNS[2], needle))

  await tools.click()
  await expect(count).toHaveText('1 of 3')
})

test('opens find from the header button, and Back to latest keeps find open', async ({ page }) => {
  const needle = unique('quillwort')
  const id = await seedLongTranscript(unique('Button search'), needle)
  await page.goto(`/#agents/${id}`)
  await expect(transcript(page).getByText('Reply 3000 done')).toBeVisible()
  await page.getByTestId('chat-find-open').click()
  await page.getByTestId('chat-find-input').fill(needle.toUpperCase())
  await expect(page.getByTestId('chat-find-count')).toHaveText('1 of 3')
  await page.getByRole('button', { name: 'Older match' }).click()
  await expect(page.getByTestId('back-to-latest')).toBeVisible()

  await page.getByTestId('back-to-latest').click()
  await expect(transcript(page).getByText('Reply 3000 done')).toBeInViewport()
  await expect(findBar(page)).toBeVisible()
  await page.getByTestId('chat-find-input').fill('no such words anywhere')
  await expect(page.getByTestId('chat-find-count')).toHaveText('No matches')

  await page.getByRole('button', { name: 'Close find' }).click()
  await expect(findBar(page)).toBeHidden()
  await page.keyboard.press('Control+k')
  await page.keyboard.type('>search in this chat')
  await page.keyboard.press('Enter')
  await expect(findBar(page)).toBeVisible()
  await expect(page.getByTestId('chat-find-input')).toBeFocused()
})

test('finds far back in the group chat while new messages wait, and leaves Ctrl+F to the browser elsewhere', async ({
  page,
  request,
}) => {
  const needle = unique('marigold')
  await seedTeamNotes(120, needle, [5, 110])
  await page.goto('/#settings')
  expect(await browserFindKept(page)).toBe(true)

  await page.goto('/#agents')
  expect(await browserFindKept(page)).toBe(true)
  await page.keyboard.press('Control+Shift+L')
  const panel = page.getByRole('complementary', { name: 'Group chat' })
  await expect(panel.getByText('Note 119 chatter')).toBeVisible()
  await panel.getByRole('combobox', { name: 'Message the group' }).click()
  await page.keyboard.press('Control+f')
  await expect(panel.getByRole('searchbox', { name: 'Find in message' })).toBeFocused()
  await expect(panel.getByTestId('chat-find')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(panel.getByTestId('message-find')).toHaveCount(0)

  await panel.getByRole('log', { name: 'Group messages' }).click()
  await page.keyboard.press('Control+f')
  await expect(panel.getByTestId('chat-find')).toBeVisible()
  await page.keyboard.type(needle)
  await expect(panel.getByTestId('chat-find-count')).toHaveText('1 of 2')
  await expect(current(page)).toContainText(`Note 110 about the ${needle} plan`)

  await page.keyboard.press('Enter')
  await expect(current(page)).toContainText(`Note 5 about the ${needle} plan`)
  await expect(current(page)).toBeInViewport()
  await expect(panel.getByTestId('team-back-to-latest')).toBeVisible()
  await expect(panel.getByText('Note 119 chatter')).toHaveCount(0)

  const live = `${needle} arrived live`
  expect((await request.post('/api/team/messages', { data: { text: live } })).ok()).toBe(true)
  await expect(panel.getByText(live)).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(panel.getByTestId('chat-find')).toBeHidden()
  await expect(panel.getByText(live)).toBeInViewport()
})
