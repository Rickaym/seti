import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { CommandCatalog, ComposerCommand, Envelope } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'

const command = (name: string, extra: Partial<ComposerCommand> = {}): ComposerCommand => ({
  name,
  description: `Runs ${name}`,
  argument_hint: '',
  aliases: [],
  builtin: true,
  unsupported: null,
  ...extra,
})

const CATALOG: CommandCatalog = {
  cwd: paths.checkout,
  probed_at: new Date().toISOString(),
  fresh: true,
  approximate: false,
  commands: [
    command('compact', { description: 'Free up context', argument_hint: '<optional custom instructions>' }),
    command('context', { description: 'Show current context usage' }),
    command('color', { unsupported: 'it only changes the terminal display' }),
    command('slack:summarize-channel', { builtin: false, description: 'Summarize a channel' }),
  ],
}

/** An idle task written straight into the database, so no agent turn ever starts. */
async function seedTask(): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, status, created_at, updated_at)
     VALUES (?, 'Composer commands', NULL, ?, 0, 'idle', ?, ?)`,
    id,
    paths.checkout,
    ts,
    ts,
  )
  await db.message(id, 'prompt', JSON.stringify({ text: 'Seeded prompt for the composer.' }), ts)
  await db.close()
  return id
}

async function openTask(page: Page, taskId: string) {
  await page.route(/\/api\/tasks\/[^/]+\/commands$/, async (route) =>
    route.fulfill({ json: { data: CATALOG, meta: {} } satisfies Envelope<CommandCatalog> }),
  )
  await page.goto(`/#agents/${taskId}`)
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await expect(page.getByText('Seeded prompt for the composer.')).toBeVisible()
  return reply
}

const status = (page: Page) => page.getByRole('status', { name: 'Composer status' })

test.describe('task composer', () => {
  let taskId = ''

  test.beforeAll(async () => {
    taskId = await seedTask()
  })

  test('long text scrolls inside the reply box instead of growing it past the screen', async ({ page }) => {
    const reply = await openTask(page, taskId)
    await reply.fill(Array.from({ length: 200 }, (_, n) => `line ${String(n)}`).join('\n'))
    const viewport = page.viewportSize()?.height ?? 0
    const box = await reply.boundingBox()
    expect(box?.height ?? Infinity).toBeLessThanOrEqual(viewport * 0.4 + 1)
    expect(await reply.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  })

  test('shows -> as typed, without the font joining it into an arrow', async ({ page }) => {
    const reply = await openTask(page, taskId)
    await reply.fill('a -> b')
    const style = await reply.evaluate((el) => {
      const computed = getComputedStyle(el)
      return { ligatures: computed.fontVariantLigatures, features: computed.fontFeatureSettings }
    })
    expect(style.ligatures).toBe('none')
    expect(style.features).toContain('"calt" 0')
    await expect(reply).toHaveValue('a -> b')
  })

  test('suggests slash commands and inserts the chosen one', async ({ page }) => {
    const reply = await openTask(page, taskId)
    await reply.fill('/')
    const list = page.getByRole('listbox', { name: 'Command suggestions' })
    await expect(list.getByRole('option')).toHaveCount(4)
    await expect(list.getByRole('option', { name: /\/color/ })).toContainText('Not supported in Seti')

    await reply.fill('/co')
    await expect(list.getByRole('option')).toHaveCount(3)
    await expect(list.getByRole('option').first()).toContainText('/compact')
    await expect(status(page)).toContainText('3 matching commands')
    await reply.press('ArrowDown')
    await expect(list.getByRole('option', { name: /\/context/ })).toHaveAttribute('aria-selected', 'true')
    await reply.press('Tab')
    await expect(reply).toHaveValue('/context ')
    await expect(list).toBeHidden()
    await expect(status(page)).toContainText('Show current context usage')

    await reply.fill('/sum')
    await expect(list.getByRole('option')).toHaveCount(1)
    await reply.press('Escape')
    await expect(list).toBeHidden()
    await expect(page).toHaveURL(new RegExp(`#agents/${taskId}$`))
  })

  test('Ctrl+Enter and Shift+Enter add a line while Enter is left to send', async ({ page }) => {
    // Frames come late on a loaded machine; keys typed meanwhile must still land at the caret.
    await page.addInitScript(() => {
      const nextFrame = window.requestAnimationFrame.bind(window)
      window.requestAnimationFrame = (callback) => window.setTimeout(() => nextFrame(callback), 300)
      window.cancelAnimationFrame = (handle) => {
        window.clearTimeout(handle)
      }
    })
    const reply = await openTask(page, taskId)
    await reply.fill('first')
    await reply.press('Control+Enter')
    await reply.pressSequentially('second')
    await reply.press('Shift+Enter')
    await reply.pressSequentially('third')
    await expect(reply).toHaveValue('first\nsecond\nthird')
    await expect(status(page)).toBeEmpty()
  })

  test('the hint is the placeholder and the paper clip shares the row with the box', async ({ page }) => {
    const reply = await openTask(page, taskId)
    await expect(reply).toHaveAttribute(
      'placeholder',
      'Enter sends, Ctrl+Enter adds a line, Esc Esc rewinds. Start with / for a command or ! to run a shell command here.',
    )
    await expect(status(page)).toBeEmpty()
    const field = await reply.boundingBox()
    const clip = await page.getByRole('button', { name: 'Attach', exact: true }).boundingBox()
    expect(clip?.x ?? 0).toBeGreaterThan((field?.x ?? 0) + (field?.width ?? 0))
    expect(Math.abs((clip?.y ?? 0) + (clip?.height ?? 0) - (field?.y ?? 0) - (field?.height ?? 0))).toBeLessThan(1)
    await reply.fill('/')
    await expect(status(page)).toContainText('Type a command name')
    await reply.fill('')
  })

  test('warns about unknown and unsupported commands and asks before sending them', async ({ page }) => {
    const reply = await openTask(page, taskId)
    let sent = false
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith(`/api/tasks/${taskId}/messages`)) {
        sent = true
      }
    })
    await reply.fill('/compcat now')
    await expect(status(page)).toHaveText('/compcat is not available to this agent. Did you mean /compact?')
    await reply.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Unknown command' })
    await expect(dialog).toContainText('/compcat is not available to this agent. Send it anyway?')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await expect(reply).toHaveValue('/compcat now')

    await reply.fill('/color red')
    await expect(status(page)).toContainText('/color is not supported in Seti')
    expect(sent).toBe(false)
  })

  test('runs a ! command in the task directory and shows the result', async ({ page }) => {
    const reply = await openTask(page, taskId)
    await reply.fill('!echo "unbalanced')
    await expect(status(page)).toContainText('Unclosed double quote')
    await reply.fill('!echo seti-shell-ok && pwd')
    await expect(status(page)).toContainText(`Runs with bash in ${paths.checkout}`)
    await reply.press('Enter')

    const entry = page.locator('[data-kind="shell"]').filter({ hasText: 'echo seti-shell-ok' })
    await expect(entry).toContainText('exit 0')
    await expect(entry).toContainText('seti-shell-ok')
    await expect(entry).toContainText(paths.checkout)
    await expect(reply).toHaveValue('')
    await expect(reply).toBeEnabled()
  })

  test('Alt+Backspace and Alt+Delete delete a word like Ctrl does', async ({ page }) => {
    const reply = await openTask(page, taskId)
    await reply.fill('hello brave new world')
    await reply.press('End')
    await reply.press('Alt+Backspace')
    await expect(reply).toHaveValue('hello brave new ')
    await reply.press('Alt+Backspace')
    await expect(reply).toHaveValue('hello brave ')
    await reply.press('Control+z')
    await expect(reply).toHaveValue('hello brave new ')
    await reply.press('Home')
    await reply.press('Alt+Delete')
    await expect(reply).toHaveValue(' brave new ')
  })

  test('the start page suggests commands and Escape closes only the list', async ({ page }) => {
    await page.route(/\/api\/commands(\?.*)?$/, async (route) =>
      route.fulfill({ json: { data: CATALOG, meta: {} } satisfies Envelope<CommandCatalog> }),
    )
    await page.goto('/#agents')
    await page.getByRole('button', { name: 'New agent', exact: true }).click()
    const prompt = page.getByRole('combobox', { name: 'Message' })
    await prompt.fill('/comp')
    const list = page.getByRole('listbox', { name: 'Command suggestions' })
    await expect(list.getByRole('option')).toHaveCount(1)
    await prompt.press('Enter')
    await expect(prompt).toHaveValue('/compact ')
    await prompt.fill('/co')
    await expect(list).toBeVisible()
    await prompt.press('Escape')
    await expect(list).toBeHidden()
    await expect(page).toHaveURL(/#agents\/new$/)
    await prompt.fill('!ls')
    await expect(page.getByRole('status', { name: 'Composer status' })).toContainText(
      'Shell commands run in an existing agent',
    )
    await prompt.fill('')
  })
})
