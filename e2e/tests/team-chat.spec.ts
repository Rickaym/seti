import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import type { TeamMember, TeamPosted } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { openSeedDb } from './support/db.js'
import { EA_HEADERS, paths } from './support/env.js'
import { apiData, expect, test } from './support/fixtures.js'

/** A handle no other task of the suite holds, since each run keeps earlier tasks. */
const HANDLE = `vm${Date.now().toString(36)}`

/** An idle task whose agent already said hello in the group chat; no agent runs. */
async function seedTask(title: string, hello: string, handle = HANDLE): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  await db.idleTask(id, title, paths.checkout, at)
  await db.run(`INSERT INTO team_member (task_id, handle, muted, updated_at) VALUES (?, ?, 0, ?)`, id, handle, at)
  await db.run(
    `INSERT INTO team_message (author_kind, author_task_id, author_handle, text, mentions, created_at)
     VALUES ('task', ?, ?, ?, ?, ?)`,
    id,
    handle,
    hello,
    JSON.stringify([{ handle: 'all', task_id: null }]),
    at,
  )
  await db.close()
  return id
}

async function box(locator: Locator) {
  const found = await locator.boundingBox()
  expect(found).not.toBeNull()
  return found ?? { x: 0, y: 0, width: 0, height: 0 }
}

const toggle = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' }).getByTestId('team-chat-toggle')
const panel = (page: Page) => page.getByRole('complementary', { name: 'Group chat' })

test('opens with the newest page and loads earlier messages on request', async ({ page }) => {
  const db = openSeedDb()
  const base = Date.now() - 60 * 60_000
  for (let n = 0; n < 60; n += 1) {
    await db.run(
      `INSERT INTO team_message (author_kind, author_task_id, author_handle, text, mentions, created_at)
       VALUES ('user', NULL, NULL, ?, '[]', ?)`,
      `Paging note ${String(n).padStart(2, '0')}`,
      new Date(base + n * 1000).toISOString(),
    )
  }
  await db.close()
  await page.goto('/#agents')
  await page.keyboard.press('Control+Shift+L')
  await expect(panel(page).getByText('Paging note 59')).toBeVisible()
  await expect(panel(page).getByText('Paging note 00', { exact: true })).toHaveCount(0)
  await panel(page).getByRole('button', { name: 'Load earlier' }).click()
  await expect(panel(page).getByText('Paging note 00', { exact: true })).toBeAttached()
})

test('renders messages as markdown and marks mentions outside code', async ({ page }) => {
  const text = [
    '**Deploy done** for @all, see `@all` in the docs.',
    '- first step',
    '- second step',
    '',
    'line one',
    'line two',
  ].join('\n')
  await seedTask('E2E markdown poster', text, `md${HANDLE}`)
  await page.goto('/#agents')
  await page.keyboard.press('Control+Shift+L')
  const message = panel(page).getByTestId('team-message').filter({ hasText: 'Deploy done' })
  await expect(message.locator('strong')).toHaveText('Deploy done')
  await expect(message.locator('code')).toHaveText('@all')
  await expect(message.locator('code [data-mention]')).toHaveCount(0)
  await expect(message.locator('[data-mention="all"]')).toHaveCount(1)
  await expect(message.getByRole('listitem')).toHaveText(['first step', 'second step'])
  await expect(message.locator('br')).toHaveCount(1)
  await expect(message.locator('time')).toHaveText(/^\d+[smhd] ago$/)
  await expect(message.locator('time')).toHaveAttribute('title', /\d/)
})

test('Copy reply shows on hover and copies the message source', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const text = '**Copy check** for @all:\n\n```ts\nconst ok = true\n```'
  await seedTask('E2E copy poster', text, `cp${HANDLE}`)
  await page.goto('/#agents')
  await page.keyboard.press('Control+Shift+L')
  const message = panel(page).getByTestId('team-message').filter({ hasText: 'Copy check' })
  const copy = message.getByRole('button', { name: 'Copy reply' })
  const corner = copy.locator('xpath=..')
  await expect(corner).toHaveCSS('opacity', '0')
  await message.locator('strong').hover()
  await expect(corner).toHaveCSS('opacity', '1')
  await copy.click()
  await expect.poll(async () => page.evaluate(async () => navigator.clipboard.readText())).toBe(text)
  await expect(copy).toHaveAttribute('data-copied', '')
})

test('opens the group chat beside any page, suggests handles, mutes an agent and shows messages live', async ({
  page,
  request,
}) => {
  const hello = 'Checking in: @all I am changing the SIP config'
  const id = await seedTask('E2E voicemail fixer', hello)
  await page.goto('/#agents')
  const main = page.getByRole('main')
  await expect(panel(page)).toHaveCount(0)
  const closed = await box(main)
  expect(closed.x + closed.width).toBe(1440)

  await page.keyboard.press('Control+Shift+L')
  await expect(panel(page)).toBeVisible()
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true')
  const open = await box(main)
  const side = await box(panel(page))
  expect(side.width).toBe(384)
  expect(open.x + open.width).toBe(side.x)
  expect(open.x).toBe(closed.x)

  const seeded = panel(page).getByTestId('team-message').filter({ hasText: 'changing the SIP config' })
  await expect(seeded.getByRole('link', { name: `@${HANDLE}` })).toHaveAttribute('href', `#agents/${id}`)
  await expect(seeded.locator('[data-mention="all"]')).toHaveText('@all')

  const composer = panel(page).getByRole('combobox', { name: 'Message the group' })
  await composer.fill(`Hey @${HANDLE.slice(0, 4)}`)
  const suggestions = panel(page).getByRole('listbox', { name: 'Mention suggestions' })
  await expect(suggestions.getByRole('option', { name: new RegExp(`^@${HANDLE}`) })).toContainText(
    'E2E voicemail fixer',
  )
  await composer.press('Enter')
  await expect(composer).toHaveValue(`Hey @${HANDLE} `)
  await composer.fill('@al')
  await expect(suggestions.getByRole('option').first()).toContainText('@all')
  await composer.press('Escape')
  await expect(suggestions).toHaveCount(0)

  await page.goto(`/#agents/${id}`)
  await openAgentSettings(page, 'Team')
  const details = page.getByRole('dialog')
  await expect(details.getByRole('textbox', { name: 'Group chat handle' })).toHaveValue(HANDLE)
  const mute = details.getByRole('button', { name: 'Mute' })
  await mute.click()
  await expect(mute).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  const member = await apiData<TeamMember>(request, `/team/members/${id}`)
  expect(member.muted).toBe(true)

  await expect(panel(page)).toBeVisible()
  await composer.fill(`@${HANDLE} are you still on SIP?`)
  await composer.press('Enter')
  await expect(composer).toHaveValue('')
  await expect(panel(page).getByRole('status', { name: 'Group chat status' })).toHaveText(
    `Posted: not sent to @${HANDLE}`,
  )
  const mine = panel(page).getByTestId('team-message').filter({ hasText: 'are you still on SIP?' })
  await expect(mine).toHaveAttribute('data-author', 'user')
  await expect(mine.getByText('You', { exact: true })).toBeVisible()

  await panel(page).getByRole('button', { name: 'Close group chat' }).click()
  await expect(panel(page)).toHaveCount(0)
  const posted = await request.post('/api/team/messages', {
    headers: EA_HEADERS,
    data: { text: 'The user says the SIP change can go out tonight.' },
  })
  expect(posted.ok()).toBe(true)
  expect(((await posted.json()) as { data: TeamPosted }).data.message.author_kind).toBe('ea')
  await expect(toggle(page).getByTestId('team-chat-unread')).toHaveText('1')
  await expect(toggle(page)).toHaveAccessibleName('Group chat, 1 unread')

  await toggle(page).click()
  const live = panel(page).getByTestId('team-message').filter({ hasText: 'can go out tonight' })
  await expect(live).toHaveAttribute('data-author', 'ea')
  await expect(live.getByText('EA', { exact: true })).toBeVisible()
  await expect(toggle(page).getByTestId('team-chat-unread')).toHaveCount(0)

  await page.reload()
  await expect(panel(page)).toBeVisible()
  await expect(panel(page).getByRole('combobox', { name: 'Message the group' })).toHaveValue('')
  await panel(page).getByRole('combobox', { name: 'Message the group' }).fill('draft kept')
  await page.reload()
  await expect(panel(page).getByRole('combobox', { name: 'Message the group' })).toHaveValue('draft kept')
  await panel(page).getByRole('combobox', { name: 'Message the group' }).fill('')
  await page.keyboard.press('Control+Shift+L')
  await expect(panel(page)).toHaveCount(0)
})
