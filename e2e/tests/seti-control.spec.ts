import type { APIRequestContext } from '@playwright/test'
import type { AuditPage, Envelope, MessagePage, Task, TeamMember } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { paths } from './support/env.js'
import { NO_SETI_TOOLS, setiPrompt } from './support/fake-claude.js'
import { apiData, expect, test, toasts, unique } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { transcript } from './support/restart.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

async function startAgent(request: APIRequestContext, title: string): Promise<Task> {
  const response = await request.post('/api/tasks', {
    data: { title, prompt: 'Say hello', cwd: paths.checkout, sandbox: false },
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

const prompts = async (request: APIRequestContext, id: string) =>
  (await apiData<MessagePage>(request, `/tasks/${id}/messages`)).messages.flatMap((row) =>
    row.kind === 'prompt' ? [row.payload.text] : [],
  )

test('Seti control is Self by default; set to Full, the agent lists agents and messages another', async ({
  page,
  request,
}) => {
  const caller = await startAgent(request, unique('Controller'))
  const target = await startAgent(request, unique('Target'))
  expect(caller.seti_control).toBe('self')

  await page.goto(`/#agents/${caller.id}`)
  await openAgentSettings(page, 'Access')
  const seti = page.getByRole('list', { name: 'Access' }).getByRole('listitem').filter({ hasText: 'Seti' })
  await expect(seti).toContainText('Seti Self')

  await send(request, caller.id, setiPrompt('list_tasks'))
  await expect(transcript(page)).toContainText(NO_SETI_TOOLS)
  await send(request, caller.id, setiPrompt('set_agent_color', { color: 'teal' }))
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${caller.id}`)).color).toBe('#3baca6')

  await page.getByRole('button', { name: 'Edit access' }).click()
  const access = page.getByRole('dialog', { name: /^Access of / })
  const levels = access.getByRole('region', { name: 'Seti control' }).getByRole('group', { name: 'Seti control level' })
  await expect(levels.getByRole('button', { name: 'Self' })).toHaveAttribute('aria-pressed', 'true')
  await levels.getByRole('button', { name: 'Full' }).click()
  await expect(toasts(page).filter({ hasText: 'Applies from the next turn' })).toBeVisible()
  await expect(levels.getByRole('button', { name: 'Full' })).toHaveAttribute('aria-pressed', 'true')
  await expect(levels.getByRole('button', { name: 'Self' })).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Escape')
  await openAgentSettings(page, 'Access')
  await expect(seti).toContainText('Seti Full')
  await page.keyboard.press('Escape')

  await send(request, caller.id, setiPrompt('list_tasks'))
  await expect(transcript(page)).toContainText(target.title)

  const { handle } = await apiData<TeamMember>(request, `/team/members/${target.id}`)
  const note = 'Hello from the controller'
  await send(request, caller.id, setiPrompt('post_team_chat', { to: `@${handle}`, text: note }))
  await expect(transcript(page)).toContainText('post_team_chat')
  const inputs = async () => {
    const found = await apiData<MessagePage>(request, `/tasks/${target.id}/messages?limit=200`)
    return found.messages.flatMap((row) => (row.kind === 'input' ? [row.payload] : []))
  }
  await expect.poll(async () => (await inputs()).map((input) => input.body)).toContain(note)
  expect((await inputs()).find((input) => input.body === note)).toMatchObject({ source: 'team', kind: 'direct' })
  expect(await prompts(request, target.id)).not.toContain(note)

  const audit = await apiData<AuditPage>(request, '/audit?actor=agent&kind=team.direct_posted')
  const sent = audit.events.find((event) => event.subject_id === caller.id)
  expect(sent?.detail).toMatchObject({ to: `@${handle}`, length: note.length })
  const calls = await apiData<AuditPage>(request, '/audit?actor=agent&kind=agent.outward')
  const call = calls.events.find((event) => event.subject_id === caller.id)
  const summary = `Seti post_team_chat \u2192 @${handle}: a direct message of ${String(note.length)} characters`
  expect(call?.summary).toBe(summary)
  expect(call?.detail).toMatchObject({ title: caller.title, target: `@${handle}`, length: note.length })
  expect(JSON.stringify(calls.events)).not.toContain(note)

  await page.goto('/#settings/audit/agent')
  const row = page.getByRole('main').getByRole('row').filter({ hasText: 'Seti post_team_chat' })
  await expect(row.getByRole('link', { name: caller.title })).toHaveAttribute('href', `#agents/${caller.id}`)
  const disclosure = row.getByRole('button', { name: /Seti post_team_chat/ })
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  const details = page.locator(`#${(await disclosure.getAttribute('aria-controls')) ?? 'missing'}`)
  await expect(details).toHaveCount(0)
  await disclosure.click()
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  await expect(details).toContainText(`@${handle}`)
  await expect(details).not.toContainText(note)
})

test('an agent with Seti control cannot stop itself through its tools', async ({ request }) => {
  const caller = await startAgent(request, unique('Self stopper'))
  expect((await request.patch(`/api/tasks/${caller.id}`, { data: { seti_control: 'full' } })).ok()).toBe(true)

  await send(request, caller.id, setiPrompt('stop_task', { task: caller.id }))
  const rows = await apiData<MessagePage>(request, `/tasks/${caller.id}/messages`)
  expect(JSON.stringify(rows.messages)).toContain('You cannot stop yourself with a seti tool')
})

test('Seti control turned off leaves the agent its status line only', async ({ page, request }) => {
  const caller = await startAgent(request, unique('Switched off'))
  await page.goto(`/#agents/${caller.id}`)
  await openAgentSettings(page, 'Access')
  await page.getByRole('button', { name: 'Edit access' }).click()
  const access = page.getByRole('dialog', { name: /^Access of / })
  const levels = access.getByRole('group', { name: 'Seti control level' })
  await levels.getByRole('button', { name: 'Off' }).click()
  await expect(levels.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${caller.id}`)).seti_control).toBe('off')
  await page.keyboard.press('Escape')
  await send(request, caller.id, setiPrompt('get_task', {}))
  await expect(transcript(page)).toContainText(NO_SETI_TOOLS)
})
