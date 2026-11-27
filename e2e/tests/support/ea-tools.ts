import type { Page } from '@playwright/test'
import type { EaTool } from '@seti/shared'

const TOOLS: EaTool[] = [
  { name: 'list_tasks', area: 'Agents', summary: 'List Seti tasks with their workspace and status.', gate: 'runs' },
  { name: 'stop_task', area: 'Agents', summary: 'Stop the running turn of one task.', gate: 'asks' },
  { name: 'list_prs', area: 'PRs and repos', summary: "List the user's open pull requests.", gate: 'runs' },
  {
    name: 'answer_question',
    area: 'Messaging',
    summary: "Answer an agent's question with the user's own words.",
    gate: 'word',
  },
  { name: 'create_channel', area: 'Channels', summary: 'Create a channel that delivers alerts.', gate: 'asks' },
]

/** Answers the EA tool list as a running EA would. */
export async function fakeEaTools(page: Page): Promise<void> {
  await page.route('**/api/ea/tools', async (route) => route.fulfill({ json: { data: { tools: TOOLS } } }))
}
