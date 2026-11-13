import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

/** Sixty lines with "Agent" and "agent" on three of them, far enough apart to scroll the box. */
const PROMPT = Array.from({ length: 60 }, (_, n) =>
  n % 20 === 7 ? `Step ${String(n)}: ask the Agent to read the agent logs` : `Line ${String(n)} of a long prompt`,
).join('\n')

async function seedTask(): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  await db.idleTask(id, 'Find in the message', paths.checkout, at)
  await db.message(id, 'prompt', JSON.stringify({ text: 'Seeded find prompt.' }), at)
  await db.close()
  return id
}

/** The text the box has selected. */
const selected = async (reply: Locator) =>
  reply.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))

/** The text of each range find marks as the current match. */
const currentMarks = async (page: Page) =>
  page.evaluate(() => {
    const current = CSS.highlights.get('seti-find-current')
    return current === undefined ? [] : [...current].map((range) => (range as Range).toString())
  })

const occurrences = (text: string, word: RegExp) => [...text.matchAll(word)].length

test('Ctrl+F in the message box finds, replaces and undoes, and leaves chat find closed', async ({ page }) => {
  const id = await seedTask()
  await page.goto(`/#agents/${id}`)
  await expect(page.getByText('Seeded find prompt.')).toBeVisible()
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.fill(PROMPT)
  await reply.evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(0, 0)
    el.scrollTo({ top: 0 })
  })

  await reply.press('Control+f')
  const field = page.getByRole('searchbox', { name: 'Find in message' })
  await expect(field).toBeFocused()
  await expect(page.getByTestId('chat-find')).toHaveCount(0)
  await field.fill('agent')
  const count = page.getByTestId('message-find-count')
  await expect(count).toHaveText('1 of 6')
  expect(await selected(reply)).toBe('Agent')
  await expect.poll(async () => currentMarks(page)).toEqual(['Agent'])

  await page.keyboard.press('Enter')
  await expect(count).toHaveText('2 of 6')
  await page.keyboard.press('F3')
  await expect(count).toHaveText('3 of 6')
  await page.keyboard.press('Shift+F3')
  await expect(count).toHaveText('2 of 6')
  await page.keyboard.press('Shift+Enter')
  await expect(count).toHaveText('1 of 6')
  await page.keyboard.press('Shift+Enter')
  await expect(count).toHaveText('6 of 6')
  await expect.poll(async () => reply.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)

  await page.getByRole('button', { name: 'Match case' }).click()
  await expect(count).toHaveText(/ of 3$/u)
  expect(await selected(reply)).toBe('agent')
  await page.getByRole('button', { name: 'Match case' }).click()
  await expect(count).toHaveText(/ of 6$/u)

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('message-find')).toHaveCount(0)
  await expect(reply).toBeFocused()
  expect((await selected(reply)).toLowerCase()).toBe('agent')
  await expect.poll(async () => currentMarks(page)).toEqual([])

  await reply.press('Control+h')
  await expect(field).toBeFocused()
  await expect(field).toHaveValue(/^agent$/iu)
  await expect(count).toHaveText(/ of 6$/u)
  const replacement = page.getByRole('textbox', { name: 'Replace with' })
  await replacement.fill('bot')
  await page.keyboard.press('Enter')
  await expect(count).toHaveText(/ of 5$/u)
  await expect(replacement).toBeFocused()
  const once = await reply.inputValue()
  expect(occurrences(once, /bot/gu)).toBe(1)
  await page.getByRole('button', { name: 'All', exact: true }).click()
  await expect(count).toHaveText('No matches')
  const all = await reply.inputValue()
  expect(occurrences(all, /agent/giu)).toBe(0)
  expect(occurrences(all, /bot/gu)).toBe(6)

  await page.keyboard.press('Escape')
  await expect(reply).toBeFocused()
  await page.keyboard.press('Control+z')
  await expect(reply).toHaveValue(once)
  await page.keyboard.press('Control+z')
  await expect(reply).toHaveValue(PROMPT)

  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Reply' })).toHaveValue(PROMPT)

  await page.getByRole('region', { name: 'Transcript' }).click()
  await page.keyboard.press('Control+f')
  await expect(page.getByTestId('chat-find')).toBeVisible()
  await expect(page.getByTestId('message-find')).toHaveCount(0)
})

test('the start page box takes Ctrl+F too, and a slash command stays in sync after replacing', async ({ page }) => {
  await page.goto('/#agents')
  const box = page.getByRole('combobox', { name: 'Message' })
  await box.fill('/compact keep the plan, drop the plan drafts')
  await box.press('Control+h')
  await page.getByRole('searchbox', { name: 'Find in message' }).fill('plan')
  await expect(page.getByTestId('message-find-count')).toHaveText(/ of 2$/u)
  await page.getByRole('textbox', { name: 'Replace with' }).fill('notes')
  await page.getByRole('button', { name: 'All', exact: true }).click()
  await expect(box).toHaveValue('/compact keep the notes, drop the notes drafts')
  await page.keyboard.press('Escape')
  await expect(box).toBeFocused()
  await expect(page.getByTestId('message-find')).toHaveCount(0)
})
