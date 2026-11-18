import fs from 'node:fs'
import path from 'node:path'
import type { APIRequestContext } from '@playwright/test'
import type { ChangeRequest, Envelope, SharedTool, SharedToolChange, Task } from '@seti/shared'
import { setiPrompt } from './fake-claude.js'
import { apiData, expect, unique } from './fixtures.js'

export const TOOL_DESCRIPTION = 'List the open invoices of a customer. Use it when someone asks what a customer owes.'
export const TOOL_REASON = 'Other agents keep asking me to look invoices up for them.'
const TOOL_FILE = 'invoices.py'

const scriptPath = (agent: Task) => path.join(agent.cwd, TOOL_FILE)

async function idle(request: APIRequestContext, id: string): Promise<void> {
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
}

/** An agent on the fake Claude Code, which keeps the script in its own folder. */
export async function startToolsmith(request: APIRequestContext): Promise<Task> {
  const response = await request.post('/api/tasks', {
    data: { title: unique('Toolsmith'), prompt: 'Say hello', sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const task = ((await response.json()) as Envelope<Task>).data
  await idle(request, task.id)
  return task
}

/** Has the agent call request_change for the script as it is now, and returns the filed proposal. */
export async function proposeTool(request: APIRequestContext, agent: Task, name: string, content: string) {
  fs.writeFileSync(scriptPath(agent), content)
  const change = {
    kind: 'shared_tool',
    name,
    description: TOOL_DESCRIPTION,
    path: TOOL_FILE,
    input: {
      type: 'object',
      properties: {
        customer: { type: 'string', description: 'The customer id.' },
        limit: { type: 'integer', description: 'How many to list.' },
      },
      required: ['customer'],
    },
    writes: false,
    needs: [{ env: 'BILLING_KEY', hosts: ['api.billing.example.com'] }],
  }
  const prompt = setiPrompt('request_change', { change, reason: TOOL_REASON })
  expect((await request.post(`/api/tasks/${agent.id}/messages`, { data: { prompt } })).ok()).toBe(true)
  await idle(request, agent.id)
  const [filed] = await apiData<ChangeRequest[]>(request, `/tasks/${agent.id}/change-requests`)
  expect(filed?.change, 'the agent filed a proposal').toMatchObject({ kind: 'shared_tool', name })
  return { requestId: filed?.id ?? '', hash: (filed?.change as SharedToolChange).snapshot.sha256 }
}

export const sharedTool = async (request: APIRequestContext, name: string) =>
  (await apiData<SharedTool[]>(request, '/shared-tools')).find((tool) => tool.name === name)
