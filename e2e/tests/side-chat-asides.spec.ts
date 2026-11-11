import type { APIRequestContext, Locator, Page } from '@playwright/test'
import type { AsideList, AuditPage, MessagePage } from '@seti/shared'
import { SIDE_ANSWER, SLOW_QUESTION } from './support/fake-side-chat.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { startAgent } from './support/grid.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { seedSession, sideChat } from './support/side-chat.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const rowIds = async (request: APIRequestContext, id: string) =>
  (await apiData<MessagePage>(request, `/tasks/${id}/messages?limit=200`)).messages.map((row) => row.id)

const storedAsides = async (request: APIRequestContext, id: string) =>
  (await apiData<AsideList>(request, `/mods/side-chat/tasks/${id}/asides`)).asides

const transcriptOf = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Transcript' })
const asidesOf = (page: Page) => transcriptOf(page).getByRole('group', { name: 'Aside' })

/** Whether `first` comes before `second` in the page. */
async function precedes(first: Locator, second: Locator): Promise<boolean> {
  const other = await second.elementHandle()
  return first.evaluate((el, node) => (el.compareDocumentPosition(node) & 4) !== 0, other)
}

async function btw(page: Page, question: string): Promise<void> {
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.fill(`/btw ${question}`)
  await reply.press('Enter')
  await expect(reply).toHaveValue('')
}

test('a /btw answer stays in the transcript at its place, survives a reload, follows up and deletes', async ({
  page,
  request,
}) => {
  const title = unique('Asides')
  const id = await startAgent(request, title)
  await seedSession(id)
  const before = await rowIds(request, id)
  await page.goto(`/#agents/${id}`)

  await btw(page, 'why this approach?')
  const dock = sideChat(page)
  await expect(dock.locator('strong', { hasText: SIDE_ANSWER })).toBeVisible()
  const asides = asidesOf(page)
  await expect(asides).toHaveCount(1)
  await expect(asides.first()).toContainText('why this approach?')
  await expect(asides.first().locator('strong', { hasText: SIDE_ANSWER })).toBeVisible()
  expect(await rowIds(request, id)).toEqual(before)

  await dock.getByRole('button', { name: 'Close side chat' }).click()
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.fill('carry on after the aside')
  await reply.press('Enter')
  const transcript = transcriptOf(page)
  const greeting = transcript.locator('[data-message-id]', { hasText: `Please greet as ${title}` })
  const later = transcript.locator('[data-message-id]', { hasText: 'carry on after the aside' })
  await expect(later).toBeVisible()
  expect(await precedes(greeting, asides.first())).toBe(true)
  expect(await precedes(asides.first(), later)).toBe(true)

  await page.reload()
  await expect(asides).toHaveCount(1)
  expect(await precedes(asides.first(), later)).toBe(true)
  const fold = asides.first().getByRole('button', { name: /^Aside/ })
  await expect(fold).toHaveAttribute('aria-expanded', 'false')
  await expect(fold).toContainText('why this approach?')
  await fold.click()
  await expect(asides.first().locator('strong', { hasText: SIDE_ANSWER })).toBeVisible()

  await btw(page, 'and then?')
  await expect(dock.getByTestId('side-chat-exchange')).toHaveCount(2)
  await expect(dock.getByTestId('side-chat-exchange').nth(1)).toContainText('about and then?')
  await expect(asides).toHaveCount(2)
  await expect.poll(async () => (await storedAsides(request, id)).length).toBe(2)
  const stored = await storedAsides(request, id)
  expect(stored.map((aside) => aside.question)).toEqual(['why this approach?', 'and then?'])
  expect(stored[1]?.chat_id).toBe(stored[0]?.chat_id)
  expect(JSON.stringify(await apiData<MessagePage>(request, `/tasks/${id}/messages?limit=200`))).not.toContain(
    'and then?',
  )

  await dock.getByRole('button', { name: 'Close side chat' }).click()
  await asides.first().getByRole('button', { name: 'Delete aside' }).click()
  await expect(asides).toHaveCount(1)
  await page.reload()
  await expect(asides).toHaveCount(1)
  await expect(asides.first()).toContainText('and then?')
  await btw(page, '')
  await expect(dock.getByTestId('side-chat-exchange')).toHaveCount(1)
  await dock.getByTestId('side-chat-exchange').getByRole('button', { name: 'Delete aside' }).click()
  await expect(dock.getByTestId('side-chat-exchange')).toHaveCount(0)
  await expect(asides).toHaveCount(0)
  const audit = await apiData<AuditPage>(request, '/audit?kind=task.aside_deleted&limit=20')
  const deleted = audit.events.filter((event) => event.subject_id === id)
  expect(deleted).toHaveLength(2)
  expect(JSON.stringify(deleted)).not.toMatch(/why this approach|and then/)
})

test('an answer streams into the transcript as it comes, and Clear in the dock removes every aside', async ({
  page,
  request,
}) => {
  const id = await startAgent(request, unique('Asides live'))
  await seedSession(id)
  await page.goto(`/#agents/${id}`)

  await btw(page, SLOW_QUESTION)
  const asides = asidesOf(page)
  await expect(asides).toHaveCount(1)
  await expect(asides.first().locator('strong', { hasText: SIDE_ANSWER })).toBeVisible()
  await expect(asides.first().getByRole('button', { name: 'Delete aside' })).toHaveCount(0)
  await expect(asides.first().getByRole('button', { name: 'Delete aside' })).toBeVisible({ timeout: 15_000 })

  const dock = sideChat(page)
  await dock.getByRole('button', { name: 'New chat' }).click()
  await dock.getByRole('textbox', { name: 'Side question' }).fill('a fresh one?')
  await dock.getByRole('textbox', { name: 'Side question' }).press('Enter')
  await expect(asides).toHaveCount(2)
  await expect(dock.locator('p', { hasText: /^New chat$/ })).toBeVisible()
  await expect.poll(async () => (await storedAsides(request, id)).length).toBe(2)
  const stored = await storedAsides(request, id)
  expect(stored[1]?.chat_id).not.toBe(stored[0]?.chat_id)

  await dock.getByRole('button', { name: 'Clear' }).click()
  const confirm = page.getByRole('dialog', { name: 'Clear asides' })
  await expect(confirm).toContainText('Delete all 2 asides')
  await confirm.getByRole('button', { name: 'Clear all' }).click()
  await expect(asides).toHaveCount(0)
  await expect(dock.getByTestId('side-chat-exchange')).toHaveCount(0)
  expect(await storedAsides(request, id)).toEqual([])
  const audit = await apiData<AuditPage>(request, '/audit?kind=task.asides_cleared&limit=20')
  expect(audit.events.find((event) => event.subject_id === id)?.detail).toMatchObject({ count: 2 })
})
