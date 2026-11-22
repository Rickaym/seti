import type { APIRequestContext, Locator, Page, TestInfo } from '@playwright/test'
import type { Envelope, MessagePage, Task, TaskMcpServer } from '@seti/shared'
import { setiPrompt, SYSTEM_PROMPT_PROMPT } from './fake-claude.js'
import { SERVERS_PROMPT, SERVERS_REPLY } from './fake-mcp-servers.js'
import { apiData, expect, unique } from './fixtures.js'

const PROBE_TIMEOUT_MS = 60_000
/** Allow hands the agent its update at once; the wait that groups other updates is 5 seconds. */
const USABLE_WITHIN_MS = 4000

/** Adds a user MCP server that is off by default, so a new agent starts without it. */
export async function addOffServer(request: APIRequestContext, name: string): Promise<void> {
  const server = { name, scope: 'user', transport: 'http', url: 'http://127.0.0.1:9/mcp' }
  expect((await request.post('/api/mcp/servers', { data: server })).ok()).toBe(true)
  const off = await request.put(`/api/mcp/defaults/${name}`, { data: { enabled: false }, timeout: PROBE_TIMEOUT_MS })
  expect(off.ok()).toBe(true)
}

export async function removeServer(request: APIRequestContext, name: string): Promise<void> {
  await request.delete(`/api/mcp/servers/${name}?scope=user`)
}

const replies = async (request: APIRequestContext, id: string) =>
  (await apiData<MessagePage>(request, `/tasks/${id}/messages?limit=100`)).messages.flatMap((row) =>
    row.kind === 'sdk' && row.payload.type === 'assistant'
      ? row.payload.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
      : [],
  )

async function send(request: APIRequestContext, id: string, prompt: string): Promise<void> {
  expect((await request.post(`/api/tasks/${id}/messages`, { data: { prompt } })).ok()).toBe(true)
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
}

/**
 * Starts an agent whose system prompt names the server as off, whose session lacks it, and which
 * then asks for it with request_change; returns the agent once its request waits.
 */
export async function askingForServer(request: APIRequestContext, server: string): Promise<Task> {
  const started = await request.post('/api/tasks', {
    data: { title: unique('Needs a server'), prompt: SYSTEM_PROMPT_PROMPT, sandbox: false },
    timeout: PROBE_TIMEOUT_MS,
  })
  expect(started.ok(), 'POST /api/tasks').toBe(true)
  const task = ((await started.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${task.id}`)).status).toBe('idle')
  const prompt = (await replies(request, task.id)).join('\n')
  expect(prompt).toMatch(new RegExp(`MCP servers on this install that are off for you: [^.]*\\b${server}\\b`))
  expect(prompt).toContain('call request_change for it at once')

  await send(request, task.id, SERVERS_PROMPT)
  expect((await replies(request, task.id)).findLast((text) => text.startsWith(SERVERS_REPLY))).not.toContain(server)
  const change = { kind: 'mcp_server', server }
  await send(request, task.id, setiPrompt('request_change', { change, reason: 'The task posts a message there.' }))
  await expect
    .poll(async () => (await apiData<Task>(request, `/tasks/${task.id}`)).blocked)
    .toBe(`Asks for the MCP server ${server}`)
  return task
}

export const requestCard = (page: Page): Locator =>
  page.getByRole('main').getByRole('region', { name: /^Change request: Turn on the MCP server / })

/**
 * Presses Allow and waits for the agent's own next turn to report the server among those its
 * session loaded; records how long that took.
 */
export async function allowAndTime(
  page: Page,
  { task, server, tap }: { task: Task; server: string; tap: boolean },
  info: TestInfo,
): Promise<void> {
  const allow = requestCard(page).getByRole('button', { name: 'Allow', exact: true })
  const from = Date.now()
  await (tap ? allow.tap() : allow.click())
  const loaded = page
    .getByRole('main')
    .getByRole('region', { name: 'Transcript' })
    .getByText(new RegExp(`${SERVERS_REPLY} \\[[^\\]]*\\b${server}\\b`))
  await expect(loaded).toBeVisible()
  const took = Date.now() - from
  info.annotations.push({ type: 'allow-to-usable', description: `${String(took)} ms` })
  process.stdout.write(`Allow to a session with ${server}: ${String(took)} ms\n`)
  expect(took).toBeLessThan(USABLE_WITHIN_MS)
  await expect(requestCard(page)).toHaveCount(0)
  const servers = await apiData<TaskMcpServer[]>(page.request, `/tasks/${task.id}/mcp`)
  expect(servers.find((entry) => entry.name === server)).toMatchObject({ enabled: true, choice: true })
  expect((await apiData<Task>(page.request, `/tasks/${task.id}`)).blocked).toBeNull()
}
