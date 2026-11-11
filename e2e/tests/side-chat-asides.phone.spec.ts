import type { APIRequestContext, Page } from '@playwright/test'
import type { AsideList, MessagePage } from '@seti/shared'
import { SIDE_ANSWER } from './support/fake-side-chat.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { startAgent } from './support/grid.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { seedSession, sideChat } from './support/side-chat.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const transcriptText = async (request: APIRequestContext, id: string) =>
  JSON.stringify((await apiData<MessagePage>(request, `/tasks/${id}/messages?limit=200`)).messages)

const asidesOf = (page: Page) =>
  page.getByRole('main').getByRole('region', { name: 'Transcript' }).getByRole('group', { name: 'Aside' })

/** Types a /btw question in the reply box and taps Ask aside, as on a phone. */
async function btw(page: Page, question: string): Promise<void> {
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.tap()
  await reply.fill(`/btw ${question}`)
  await page.getByRole('button', { name: 'Ask aside', exact: true }).tap()
  await expect(reply).toHaveValue('')
}

test('a /btw answer stays in the phone transcript, survives a reload, follows up and deletes', async ({
  page,
  request,
}) => {
  const id = await startAgent(request, unique('Phone asides'))
  await seedSession(id)
  await page.goto(`/#agents/${id}`)

  await btw(page, 'why this approach?')
  const sheet = sideChat(page)
  await expect(sheet.locator('strong', { hasText: SIDE_ANSWER })).toBeVisible()
  await expectFitsPhone(page, 'side chat sheet with its toolbar')
  await sheet.getByRole('button', { name: 'Close side chat' }).tap()
  await expect(sheet).toHaveCount(0)

  const asides = asidesOf(page)
  await expect(asides).toHaveCount(1)
  await expect(asides.first().locator('strong', { hasText: SIDE_ANSWER })).toBeVisible()
  await expectFitsPhone(page, 'an aside in the transcript')
  expect(await transcriptText(request, id)).not.toContain('why this approach')

  await page.reload()
  await expect(asides).toHaveCount(1)
  const fold = asides.first().getByRole('button', { name: /^Aside/ })
  await expect(fold).toHaveAttribute('aria-expanded', 'false')
  await fold.tap()
  await expect(asides.first().locator('strong', { hasText: SIDE_ANSWER })).toBeVisible()

  await btw(page, 'and then?')
  await expect(sheet.getByTestId('side-chat-exchange')).toHaveCount(2)
  await expect(sheet.getByTestId('side-chat-exchange').nth(1)).toContainText('about and then?')
  const storedAsides = async () => (await apiData<AsideList>(request, `/mods/side-chat/tasks/${id}/asides`)).asides
  await expect.poll(async () => (await storedAsides()).length).toBe(2)
  const stored = await storedAsides()
  expect(stored[1]?.chat_id).toBe(stored[0]?.chat_id)
  await sheet.getByRole('button', { name: 'Close side chat' }).tap()
  await expect(asides).toHaveCount(2)

  await asides.first().getByRole('button', { name: 'Delete aside' }).tap()
  await expect(asides).toHaveCount(1)
  await expect(asides.first()).toContainText('and then?')
  await page.reload()
  await expect(asides).toHaveCount(1)
  await expectFitsPhone(page, 'the transcript after a delete')
})
