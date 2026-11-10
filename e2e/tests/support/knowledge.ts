import type { APIRequestContext } from '@playwright/test'
import type { Envelope, KnowledgeNote, MessagePage, Task } from '@seti/shared'
import { paths } from './env.js'
import { setiPrompt, SYSTEM_PROMPT_PROMPT } from './fake-claude.js'
import { apiData, expect, unique } from './fixtures.js'

async function startAgent(request: APIRequestContext, prompt: string): Promise<Task> {
  const response = await request.post('/api/tasks', {
    data: { title: unique('Knower'), prompt, cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const task = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${task.id}`)).status).toBe('idle')
  return task
}

/** Has a fake agent call propose_knowledge, as Claude Code would, and returns its proposal. */
export async function proposeAsAgent(
  request: APIRequestContext,
  title: string,
): Promise<{ agent: Task; note: KnowledgeNote }> {
  const fields = {
    kind: 'gotcha',
    title,
    body: 'The e2e suite needs a fresh build: run pnpm build before pnpm e2e.',
    verify: 'pnpm build && pnpm e2e smoke',
    sources: [{ kind: 'path', ref: 'CONTRIBUTING.md' }],
  }
  const agent = await startAgent(request, setiPrompt('propose_knowledge', fields))
  let note: KnowledgeNote | undefined
  await expect
    .poll(async () => {
      note = (await apiData<KnowledgeNote[]>(request, '/knowledge?status=proposed')).find(
        (entry) => entry.title === title,
      )
      return note?.proposer_task_id
    })
    .toBe(agent.id)
  if (note === undefined) {
    throw new Error('the proposal was not filed')
  }
  return { agent, note }
}

/** The knowledge index a new agent gets in its system prompt, as the fake Claude replies it. */
export async function newAgentIndex(request: APIRequestContext): Promise<string> {
  const agent = await startAgent(request, SYSTEM_PROMPT_PROMPT)
  const { messages } = await apiData<MessagePage>(request, `/tasks/${agent.id}/messages?limit=50`)
  const texts = messages.flatMap((row) =>
    row.kind === 'sdk' && row.payload.type === 'assistant'
      ? row.payload.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
      : [],
  )
  const prompt = texts.find((text) => text.includes('<knowledge_index>')) ?? ''
  return /<knowledge_index>[\s\S]*<\/knowledge_index>/.exec(prompt)?.[0] ?? ''
}
