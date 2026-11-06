import fs from 'node:fs'
import path from 'node:path'
import type { APIRequestContext } from '@playwright/test'
import type { ContextPack } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { paths } from './support/env.js'
import { apiData, expect, test, unique, waitForToastsToClear } from './support/fixtures.js'

const SAVE = 'Control+s'
const PACK_PATH = /^\/api\/context\/packs\/[0-9a-f-]{36}$/

function writeUserFile(content: string | null): void {
  fs.mkdirSync(path.dirname(paths.userClaudeMd), { recursive: true })
  if (content === null) {
    fs.rmSync(paths.userClaudeMd, { force: true })
  } else {
    fs.writeFileSync(paths.userClaudeMd, content)
  }
}

const userFileOnDisk = () => fs.readFileSync(paths.userClaudeMd, 'utf8')

test('create, edit with Ctrl+S and delete a context pack', async ({ page, request }) => {
  const name = unique('e2e-pack')
  await page.goto('/#context')

  await page.getByRole('button', { name: 'New context pack' }).click()
  await expect(page.getByRole('heading', { name: 'New context pack' })).toBeVisible()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByLabel('Description', { exact: true }).fill('Attached by the e2e suite')
  await page.getByLabel('Pack content').fill('First body')
  const reopened = page.waitForResponse(
    (response) => response.request().method() === 'GET' && PACK_PATH.test(new URL(response.url()).pathname),
  )
  await page.keyboard.press(SAVE)
  await reopened
  await expect(page).toHaveURL(/#context\/pack:[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { name })).toBeVisible()
  await expect(page.getByLabel('Pack content')).toHaveValue('First body')

  const unsaved = page.getByText('unsaved', { exact: true })
  await page.getByLabel('Pack content').fill('Second body')
  await expect(unsaved).toBeVisible()
  await page.keyboard.press(SAVE)
  await expect(unsaved).toBeHidden()
  const savedBody = async () =>
    (await apiData<ContextPack[]>(request, '/context/packs')).find((pack) => pack.name === name)?.body
  await expect.poll(savedBody).toBe('Second body')

  await waitForToastsToClear(page)
  await page.getByRole('button', { name: 'Delete context pack' }).click()
  const confirm = page.getByRole('dialog', { name: 'Confirm' })
  await expect(confirm).toContainText(`Delete context pack "${name}"?`)
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(page).toHaveURL(/#context$/)
  await expect(page.getByRole('button', { name: new RegExp(name) })).toBeHidden()
  const names = async () => (await apiData<ContextPack[]>(request, '/context/packs')).map((pack) => pack.name)
  await expect.poll(names).not.toContain(name)
})

test.describe('user CLAUDE.md', () => {
  test.use({ allowedHttpStatuses: [409] })

  test('creates and saves the file in the Claude home', async ({ page }) => {
    writeUserFile(null)
    await page.goto('/#context/user')
    await expect(page.getByRole('heading', { name: 'User level / CLAUDE.md' })).toBeVisible()
    await expect(page.getByText(paths.userClaudeMd)).toBeVisible()
    await expect(page.getByText('This file does not exist yet. Saving creates it.')).toBeVisible()

    await page.getByLabel('File content').fill('# E2E rules\n\nKeep answers short.')
    await expect(page.getByText('unsaved', { exact: true })).toBeVisible()
    await page.keyboard.press(SAVE)
    await expect(page.getByText('unsaved', { exact: true })).toBeHidden()
    await expect.poll(userFileOnDisk).toBe('# E2E rules\n\nKeep answers short.\n')

    await page.getByLabel('File content').fill('# E2E rules\n\nKeep answers shorter.\n')
    await waitForToastsToClear(page)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect.poll(userFileOnDisk).toBe('# E2E rules\n\nKeep answers shorter.\n')
  })

  test('shows a conflict when the file changed on disk, then overwrites it', async ({ page }) => {
    writeUserFile('loaded version\n')
    await page.goto('/#context/user')
    const editor = page.getByLabel('File content')
    await expect(editor).toHaveValue('loaded version\n')

    writeUserFile('changed on disk\n')
    await editor.fill('my edit\n')
    await page.keyboard.press(SAVE)
    await expect(page.getByText('This file changed on disk after you opened it.', { exact: false })).toBeVisible()
    expect(userFileOnDisk()).toBe('changed on disk\n')

    await page.getByRole('button', { name: 'Overwrite' }).click()
    await expect(page.getByText('This file changed on disk after you opened it.', { exact: false })).toBeHidden()
    await expect.poll(userFileOnDisk).toBe('my edit\n')
  })
})

test.describe('the built-in Seti guide pack', () => {
  const guide = async (request: APIRequestContext) => {
    const found = (await apiData<ContextPack[]>(request, '/context/packs')).find(
      (pack) => pack.builtin && pack.kind === 'reference',
    )
    if (found === undefined) {
      throw new Error('no built-in pack')
    }
    return found
  }

  test.afterEach(async ({ request }) => {
    await request.put(`/api/context/packs/${(await guide(request)).id}/default`, { data: { linked_by_default: true } })
  })

  test('shows read-only, switches its default and is linked to new agents', async ({ page, request }) => {
    await page.goto('/#context')
    await page.getByRole('button', { name: /^Seti guide/ }).click()
    const main = page.getByRole('main')
    await expect(main.getByRole('heading', { name: 'Seti guide', level: 2 })).toBeVisible()
    await expect(main.getByRole('status')).toContainText('Built into Seti and read-only')
    await expect(main.getByRole('heading', { name: 'Group chat' })).toBeVisible()
    await expect(main.getByRole('button', { name: 'Save' })).toBeHidden()
    await expect(main.getByRole('button', { name: 'Delete context pack' })).toBeHidden()

    const toggle = main.getByRole('switch', { name: 'Seti guide on by default' })
    await expect(toggle).toBeChecked()
    await toggle.click()
    await expect(toggle).not.toBeChecked()
    await expect.poll(async () => (await guide(request)).linked_by_default).toBe(false)
    await toggle.click()
    await expect.poll(async () => (await guide(request)).linked_by_default).toBe(true)

    await page.goto('/#agents/new')
    await page.getByLabel('Message').fill('Sketch the offsite agenda')
    await page.getByLabel('Message').press('Enter')
    await expect(page).toHaveURL(/#agents\/[\da-f-]{36}$/)
    const id = new URL(page.url()).hash.split('/')[1] ?? ''
    await openAgentSettings(page, 'Access')
    const packs = page.getByRole('list', { name: 'Access' }).getByRole('listitem').filter({ hasText: 'pack' })
    await expect(packs).toHaveText(/^\d+ packs?$/)
    await page.keyboard.press('Escape')
    await expect(main.getByLabel('Setup', { exact: true })).toBeHidden()
    await expect(main).not.toContainText('Set up:')
    const linked = await apiData<{ name: string }[]>(request, `/tasks/${id}/context-packs`)
    expect(linked.map((pack) => pack.name)).toContain('Seti guide')
    await page.goto('/#agents')
    expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
  })

  test('a default switch that answers after the user left keeps them where they went', async ({ page, request }) => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/api/context/packs/*/default', async (route) => {
      const response = await route.fetch()
      await held
      await route.fulfill({ response })
    })
    await page.goto('/#context')
    await page.getByRole('button', { name: /^Seti guide/ }).click()
    await page.getByRole('main').getByRole('switch', { name: 'Seti guide on by default' }).click()
    await expect.poll(async () => (await guide(request)).linked_by_default).toBe(false)

    await page.goto('/#agents/new')
    await expect(page.getByLabel('Message')).toBeEditable()
    const reloaded = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/context/files')
    release()
    await reloaded
    await expect(page).toHaveURL(/#agents\/new$/)
    await expect(page.getByLabel('Message')).toBeEditable()
  })
})

const named = (name: string) => new RegExp(`^${name.replace(/[()]/g, '\\$&')}`)

test('roles have their own section, built-in roles duplicate into editable ones, new roles go there', async ({
  page,
  request,
}) => {
  await page.goto('/#context')
  const roles = page.getByRole('region', { name: 'Roles' })
  const packs = page.getByRole('region', { name: 'Context packs' })
  for (const name of ['Lead', 'Reviewer', 'Watcher']) {
    await expect(roles.getByRole('button', { name: named(`${name} Built in`) })).toBeVisible()
    await expect(packs.getByRole('button', { name: named(`${name} Built in`) })).toBeHidden()
  }
  await expect(packs.getByRole('button', { name: /^Seti guide/ })).toBeVisible()

  await roles.getByRole('button', { name: /^Reviewer Built in/ }).click()
  const main = page.getByRole('main')
  await expect(main.getByRole('status')).toContainText('Built into Seti and read-only')
  await expect(main.getByText("Reviewer: you review PRs and other agents' work; you do not build it.")).toBeVisible()
  await expect(main.getByRole('switch')).toBeHidden()
  await expect(main.getByRole('button', { name: 'Save' })).toBeHidden()
  await main.getByRole('button', { name: 'Duplicate to edit' }).click()
  const title = main.getByRole('heading', { name: /^Reviewer \(copy( \d+)?\)$/, level: 2 })
  await expect(title).toBeVisible()
  await expect(main.getByLabel('Role content')).toHaveValue(/^Reviewer: you review PRs/)
  await expect(roles.getByRole('button', { name: named((await title.textContent()) ?? '') })).toBeVisible()

  const name = unique('e2e-role')
  await roles.getByRole('button', { name: 'New role' }).click()
  await expect(main.getByRole('heading', { name: 'New role' })).toBeVisible()
  await main.getByLabel('Name', { exact: true }).fill(name)
  await main.getByLabel('Role content').fill('Docs owner: you keep the docs current.')
  await page.keyboard.press(SAVE)
  await expect(page).toHaveURL(/#context\/pack:[0-9a-f-]{36}$/)
  await expect(roles.getByRole('button', { name: named(name) })).toBeVisible()
  await expect(packs.getByRole('button', { name: named(name) })).toBeHidden()
  const saved = (await apiData<ContextPack[]>(request, '/context/packs')).find((pack) => pack.name === name)
  expect(saved).toMatchObject({ kind: 'role', builtin: false, linked_by_default: false })

  await waitForToastsToClear(page)
  await main.getByRole('button', { name: 'Delete role' }).click()
  await page.getByRole('dialog', { name: 'Confirm' }).getByRole('button', { name: 'Delete' }).click()
  await expect(roles.getByRole('button', { name: named(name) })).toBeHidden()
})
