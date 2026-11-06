import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { APIRequestContext, Page } from '@playwright/test'
import {
  modToolName,
  type AuditPage,
  type ChannelSecret,
  type Envelope,
  type ModActionResult,
  type ModAsk,
  type ModList,
  type ModManifestInput,
  type Task,
} from '@seti/shared'
import { EA_HEADERS, paths } from './support/env.js'
import { setiPrompt } from './support/fake-claude.js'
import { apiData, expect, toasts, unique } from './support/fixtures.js'
import { builderAgent, KITCHEN_SINK, sinkConnection } from './support/kitchen-sink.js'
import { fixtureCopy, installFolder, removeMod } from './support/mod-fixtures.js'
import { openModsInDevMode } from './support/mod-packages.js'
import { VIEW_CONSOLE_ERRORS, VIEW_HTTP_STATUSES, VIEW_VIOLATIONS } from './support/mod-views.js'
import { transcript } from './support/restart.js'
import { sinkTest as test } from './support/sink-upstream.js'
import { openViewerFile } from './support/viewer-files.js'

test.use({
  allowedCspViolations: VIEW_VIOLATIONS,
  allowedConsoleErrors: VIEW_CONSOLE_ERRORS,
  allowedHttpStatuses: VIEW_HTTP_STATUSES,
})

test.afterEach(async ({ request }) => {
  await removeMod(request, KITCHEN_SINK)
})

const palette = (page: Page) => page.getByRole('dialog', { name: 'Search Seti' })

async function runFromPalette(page: Page, query: string, option: RegExp) {
  await page.keyboard.press('Control+k')
  await palette(page).getByRole('combobox').fill(query)
  await palette(page).getByRole('option', { name: option }).click()
  await expect(palette(page)).toBeHidden()
}

async function installSink(request: APIRequestContext): Promise<void> {
  const connection = await sinkConnection(request)
  await installFolder(request, fixtureCopy(KITCHEN_SINK), { SINK_TOKEN: connection })
}

test('installs the kitchen sink after consent in Seti words, and uninstalls it with its data', async ({
  page,
  request,
}) => {
  const connection = await sinkConnection(request)
  await openModsInDevMode(page)
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page).toHaveURL(/#settings\/mods\/add$/)
  await main.getByRole('textbox', { name: 'Folder' }).fill(fixtureCopy(KITCHEN_SINK))
  await main.getByRole('textbox', { name: 'Folder' }).press('Enter')
  const check = main.getByRole('region', { name: 'Check' })
  const can = check.getByRole('list', { name: 'What Kitchen sink can do' })
  for (const line of [
    'Reads @sink-builder: status, PRs and transcripts. Direct messages stay hidden.',
    'Renames and pins agents and links their PRs. Asks you before it starts an agent.',
    'Posts in the group chat as Kitchen sink, and messages one agent directly.',
    'Reads files matching notes/**/*.md in the folders of @sink-builder. Never keys, credentials or .env files.',
    'Sends and receives data with api.sink.test. It can send what it reads there.',
    'Uses your SINK_TOKEN connection with api.sink.test. It never sees the key',
    'Keeps up to 1 MB of its own data in Seti.',
    'Sends you notifications: Sink digest.',
  ]) {
    await expect(can).toContainText(line)
  }
  await expect(can).toContainText('Team [Team] writes tests first.')
  const warnings = check.getByRole('list', { name: 'Warnings' })
  await expect(warnings).toContainText('Its views run scripts, which can reach the internet through WebRTC')
  await expect(warnings).toContainText('Its file viewers read every file you open with them')
  await expect(check.getByRole('button', { name: 'Install' })).toBeDisabled()
  await check.getByRole('combobox', { name: 'Connection for SINK_TOKEN' }).selectOption(connection)
  await check.getByRole('button', { name: 'Install' }).click()
  await expect(page).toHaveURL(/#settings\/mods\/kitchen-sink$/)
  await expect(main.getByRole('button', { name: 'On', exact: true })).toHaveAttribute('aria-pressed', 'true')

  await main.getByRole('button', { name: 'Uninstall' }).click()
  const confirm = page.getByRole('dialog', { name: 'Uninstall Kitchen sink?' })
  await expect(confirm.getByRole('button', { name: 'Delete its data' })).toHaveAttribute('aria-pressed', 'true')
  await confirm.getByRole('button', { name: 'Uninstall' }).click()
  await expect(page).toHaveURL(/#settings\/mods$/)
  await expect(main.getByRole('region', { name: 'Mods' })).not.toContainText('Kitchen sink')
  const audit = await apiData<AuditPage>(request, '/audit?kind=mod.uninstalled')
  expect(audit.events[0]?.detail).toMatchObject({ mod: KITCHEN_SINK, data_deleted: true })
})

test('runs its command from the palette, the composer, the EA and an agent, each as the mod', async ({
  page,
  request,
  sink,
}) => {
  await installSink(request)
  const builder = await builderAgent(request)
  await page.goto(`/#agents/${builder.id}`)
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await expect(reply).toBeVisible()
  await runFromPalette(page, '>summarize', /^Summarize/)
  await expect(toasts(page).filter({ hasText: 'Sink summary of Sink builder for team core: All quiet' })).toBeVisible()
  expect(sink.seen.at(-1)?.headers.authorization).toMatch(/^Bearer sink-/)

  await reply.fill('/sink from the composer')
  await reply.press('Enter')
  await expect(toasts(page).filter({ hasText: 'All quiet (from the composer)' })).toBeVisible()

  const ea = await request.post(`/api/mods/${KITCHEN_SINK}/actions/summarize`, {
    headers: EA_HEADERS,
    data: { args: { task: builder.title, note: 'for the EA' } },
  })
  expect(ea.status(), await ea.text()).toBe(200)
  const answer = ((await ea.json()) as Envelope<ModActionResult>).data
  expect(answer.text).toContain('All quiet (for the EA)')
  expect(JSON.stringify(answer)).not.toContain(sink.seen.at(-1)?.headers.authorization ?? 'none')

  const caller = await request.post('/api/tasks', {
    data: {
      title: unique('Sink caller'),
      prompt: 'Say hello',
      cwd: paths.checkout,
      sandbox: false,
      seti_control: 'full',
    },
  })
  const agent = ((await caller.json()) as Envelope<{ id: string }>).data
  await expect.poll(async () => (await apiData<{ status: string }>(request, `/tasks/${agent.id}`)).status).toBe('idle')
  const prompt = setiPrompt(modToolName(KITCHEN_SINK, 'summarize'), { task: builder.id, note: 'for an agent' })
  expect((await request.post(`/api/tasks/${agent.id}/messages`, { data: { prompt } })).ok()).toBe(true)
  await page.goto(`/#agents/${agent.id}`)
  await expect(transcript(page)).toContainText('<mod_output mod="kitchen-sink">')
  await expect(transcript(page)).toContainText('All quiet (for an agent)')

  const audit = await apiData<AuditPage>(request, `/audit?kind=mod.${KITCHEN_SINK}.summarized`)
  expect(audit.events.length).toBeGreaterThanOrEqual(4)
  expect(audit.events.every((event) => event.actor === `mod:${KITCHEN_SINK}`)).toBe(true)
})

test('reads a signed webhook, shows its status item, and its view runs it through the bridge', async ({
  page,
  request,
}) => {
  await installSink(request)
  const builder = await builderAgent(request)
  const made = await request.post('/api/channels', {
    data: { name: unique('Sink events'), preset: `${KITCHEN_SINK}.sink` },
  })
  expect(made.status(), await made.text()).toBe(200)
  const created = ((await made.json()) as Envelope<ChannelSecret>).data
  const body = JSON.stringify({ event: 'deployed', text: 'v2 is out' })
  const signature = `sha256=${createHmac('sha256', created.secret ?? '')
    .update(body)
    .digest('hex')}`
  const hook = await request.post(`/hooks/${created.channel.id}`, {
    headers: { 'content-type': 'application/json', 'x-sink-signature': signature },
    data: body,
  })
  expect(hook.status(), await hook.text()).toBe(200)

  await page.goto(`/#agents/${builder.id}`)
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Sink' }).click()
  const frame = page.frameLocator('iframe[title="Kitchen sink: Sink"]')
  const background = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--background').trim(),
  )
  await expect(frame.locator('#theme')).toHaveText(`Theme light ${background}`)
  await page.evaluate(() => {
    document.documentElement.classList.add('dark')
  })
  await expect(frame.locator('#theme')).toContainText('Theme dark')
  await frame.getByRole('button', { name: 'Summarize' }).click()
  await expect(frame.locator('#result')).toContainText('Ran: Sink summary of Sink builder')
  await expect(frame.locator('#summaries')).toContainText('Sink builder: All quiet')
  await expect(page.getByRole('button', { name: /^Kitchen sink: \d+ summaries$/ })).toBeVisible({ timeout: 15_000 })

  await page.goto(`/#agents/${builder.id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await openViewerFile(page, 'stock.sink')
  await expect(page.frameLocator('iframe[title="Kitchen sink: Sink file"]').locator('#text')).toHaveText(
    'stock.sink: 3 sink lines',
  )
})

test('asks before it starts an agent, and only the Allow on the toast in Seti starts it', async ({ page, request }) => {
  await installSink(request)
  const builder = await builderAgent(request)
  await page.goto(`/#agents/${builder.id}`)
  await runFromPalette(page, '>ask to start', /^Ask to start a helper/)
  await expect(toasts(page).filter({ hasText: 'Asked you to start Sink helper' })).toBeVisible()
  const ask = toasts(page).filter({ hasText: 'Kitchen sink asks you' })
  await expect(ask).toContainText('Start an agent "Sink helper" with this prompt:', { timeout: 15_000 })
  await expect(ask.getByRole('blockquote', { name: 'Prompt' })).toHaveText('Tidy the sink notes and report back.')
  const open = await apiData<ModAsk[]>(request, '/mod-asks')
  const id = open.find((entry) => entry.mod_id === KITCHEN_SINK)?.id ?? ''
  const byEa = await request.post(`/api/mod-asks/${id}`, { headers: EA_HEADERS, data: { decision: 'allow' } })
  expect(byEa.status()).toBe(403)
  const before = await apiData<Task[]>(request, '/tasks')
  expect(before.some((task) => task.title === 'Sink helper')).toBe(false)

  await ask.getByRole('button', { name: 'Allow' }).click()
  await expect(toasts(page).filter({ hasText: /^Started "Sink helper"/ })).toBeVisible()
  await expect(ask).toHaveCount(0)
  const started = (await apiData<Task[]>(request, '/tasks')).find((task) => task.title === 'Sink helper')
  expect(started).toMatchObject({ sandbox: true, seti_control: 'self' })
  const audit = await apiData<AuditPage>(request, '/audit?kind=mod.ask_allowed')
  expect(audit.events[0]).toMatchObject({ actor: 'user', subject_id: KITCHEN_SINK })
})

test('an update that adds a host waits for consent while the old version keeps running', async ({ request }) => {
  const folder = fixtureCopy(KITCHEN_SINK)
  await installFolder(request, folder, { SINK_TOKEN: await sinkConnection(request) })
  const file = path.join(folder, 'seti-mod.json')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as ModManifestInput
  manifest.version = '1.1.0'
  manifest.capabilities = manifest.capabilities?.map((entry) =>
    entry.name === 'net.fetch' ? { ...entry, hosts: ['api.sink.test', 'upload.sink.test'] } : entry,
  )
  fs.writeFileSync(file, JSON.stringify(manifest))
  const checked = await request.post(`/api/mod-admin/mods/${KITCHEN_SINK}/update/check`, { data: {} })
  expect(checked.status(), await checked.text()).toBe(200)
  const mod = (await apiData<ModList>(request, '/mods')).mods.find((entry) => entry.id === KITCHEN_SINK)
  expect(mod).toMatchObject({ version: '1.0.0', running: true })
  expect(mod?.install?.pending).toMatchObject({ version: '1.1.0', reason: 'consent' })
  expect(mod?.install?.pending?.changes).toContain(
    'Now also: Sends and receives data with upload.sink.test. It can send what it reads there.',
  )
  const builder = await builderAgent(request)
  const ran = await request.post(`/api/mods/${KITCHEN_SINK}/actions/summarize`, {
    data: { args: { task: builder.id } },
  })
  expect(ran.status(), await ran.text()).toBe(200)
})
