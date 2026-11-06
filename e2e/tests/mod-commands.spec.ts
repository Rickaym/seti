import type { APIRequestContext, Page } from '@playwright/test'
import type { AuditPage, Envelope, ModActionResult, Task } from '@seti/shared'
import { EA_HEADERS, paths } from './support/env.js'
import { NO_SETI_TOOLS, setiPrompt } from './support/fake-claude.js'
import { apiData, expect, test, toasts, unique } from './support/fixtures.js'
import { resetSampleMod, sampleToggle, setModEnabled } from './support/mods.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { transcript } from './support/restart.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test.afterEach(async ({ request }) => {
  await resetSampleMod(request)
})

async function startAgent(request: APIRequestContext): Promise<Task> {
  const response = await request.post('/api/tasks', {
    data: { title: unique('Mod commands'), prompt: 'Say hello', cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const task = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${task.id}`)).status).toBe('idle')
  return task
}

async function send(request: APIRequestContext, id: string, prompt: string): Promise<void> {
  expect((await request.post(`/api/tasks/${id}/messages`, { data: { prompt } })).ok()).toBe(true)
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
}

const palette = (page: Page) => page.getByRole('dialog', { name: 'Search Seti' })

async function runFromPalette(page: Page, query: string, option: RegExp) {
  await page.keyboard.press('Control+k')
  await palette(page).getByRole('combobox').fill(query)
  await palette(page).getByRole('option', { name: option }).click()
  await expect(palette(page)).toBeHidden()
}

const reply = (page: Page) => page.getByRole('combobox', { name: 'Reply' })
const status = (page: Page) => page.getByRole('status', { name: 'Composer status' })

test('a mod command runs from the palette, the composer, for the EA and as an agent tool', async ({
  page,
  request,
}) => {
  await setModEnabled(request, 'sample', true)
  const agent = await startAgent(request)
  await page.goto(`/#agents/${agent.id}`)
  await expect(reply(page)).toBeVisible()

  await runFromPalette(page, '>sample count', /^Count/)
  await expect(toasts(page).filter({ hasText: /The sample counted to \d+/ })).toBeVisible()
  await runFromPalette(page, '>sample wave', /^Wave/)
  await expect(toasts(page).filter({ hasText: `The sample waved at ${agent.id} for the user` })).toBeVisible()

  await reply(page).fill('/sample from the composer')
  await expect(page.getByRole('button', { name: 'Interrupt and send' })).toHaveCount(0)
  await reply(page).press('Enter')
  await expect(reply(page)).toHaveValue('')
  await expect(
    toasts(page).filter({ hasText: `The sample waved at ${agent.id} for the user: from the composer` }),
  ).toBeVisible()

  const ea = await request.post('/api/mods/sample/actions/wave', {
    headers: EA_HEADERS,
    data: { args: { task: agent.title, note: 'from the EA' } },
  })
  expect(ea.status(), await ea.text()).toBe(200)
  expect(((await ea.json()) as Envelope<ModActionResult>).data.text).toBe(
    `The sample waved at ${agent.id} for the ea: from the EA`,
  )
  const counted = await request.post('/api/mods/sample/actions/count', { headers: EA_HEADERS, data: { args: {} } })
  expect(counted.status(), await counted.text()).toBe(200)
  const audit = await apiData<AuditPage>(request, '/audit?kind=mod.action_run')
  expect(audit.events[0]?.detail).toMatchObject({ via: 'ea', mod: 'sample', action: 'count' })

  await send(request, agent.id, setiPrompt('mod_sample_wave', { note: 'from the agent' }))
  await expect(transcript(page)).toContainText(`The sample waved at ${agent.id} for the agent: from the agent`)
  await send(request, agent.id, setiPrompt('mod_sample_count'))
  await expect(transcript(page)).toContainText(NO_SETI_TOOLS)
})

test('a command of a bundled mod that is off says so, with one tap to turn it on', async ({ page, request }) => {
  const agent = await startAgent(request)
  await page.goto(`/#agents/${agent.id}`)
  await reply(page).fill('/sample hi')
  await expect(status(page)).toContainText('Sample is off')
  await reply(page).press('Enter')
  await expect(reply(page)).toHaveValue('/sample hi')
  const refused = await request.post(`/api/tasks/${agent.id}/messages`, { data: { prompt: '/sample hi' } })
  expect(refused.status()).toBe(400)
  expect(await refused.text()).toContain('/sample belongs to Sample, which is off')

  await status(page).getByRole('button', { name: 'Turn on' }).click()
  await expect(toasts(page).filter({ hasText: 'Sample is on' })).toBeVisible()
  await expect(status(page)).not.toContainText('Sample is off')
  await reply(page).press('Enter')
  await expect(toasts(page).filter({ hasText: `The sample waved at ${agent.id} for the user: hi` })).toBeVisible()

  await setModEnabled(request, 'sample', false)
  await page.reload()
  await page.keyboard.press('Control+k')
  await palette(page).getByRole('combobox').fill('>sample count')
  const option = palette(page).getByRole('option', { name: /^Count/ })
  await expect(option).toContainText('Sample is off')
  await option.click()
  const notice = toasts(page).filter({ hasText: 'Sample is off' })
  await expect(notice).toContainText('Once on it may: Keeps up to 1 MB of its own data in Seti.')
  await notice.getByRole('button', { name: 'Turn on' }).click()
  await expect(toasts(page).filter({ hasText: 'Sample is on' })).toBeVisible()
  await expect.poll(async () => (await apiData<{ running: boolean }>(request, '/mods/sample')).running).toBe(true)
})

test("a bundled mod's input hook sees keys while it is on, and none once it is off", async ({ page, request }) => {
  await setModEnabled(request, 'sample', true)
  await page.goto('/#settings/mods')
  const footer = page.getByRole('contentinfo')
  await expect(footer).toContainText('Sample on')
  await page.keyboard.press('Alt+Shift+K')
  await expect(footer).toContainText('Sample on, 1 keys')
  await sampleToggle(page).click()
  await expect(footer).not.toContainText('Sample on')
  await page.keyboard.press('Alt+Shift+K')
  await sampleToggle(page).click()
  await expect(footer).toContainText('Sample on, 1 keys')
})
