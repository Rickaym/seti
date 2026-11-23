import type { Envelope, MessagePage, Task } from '@seti/shared'
import { paths, SPLIT_NODE } from './support/env.js'
import { PUSH_PROMPT, PUSH_QUESTION } from './support/fake-question.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { agentQuestions, askingAgent, lastReply } from './support/questions.js'
import { RESUME_PROMPT, RESUMED_NOTE, startWorkingAgent, transcript } from './support/restart.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('a turn a restart cuts off resumes by itself, marked in the transcript', async ({ page, request, setiServer }) => {
  test.skip(SPLIT_NODE, 'a separate node keeps the turn going across a restart')
  const id = await startWorkingAgent(request)
  await setiServer.restart()

  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  await page.goto(`/#agents/${id}`)
  await expect(transcript(page)).toContainText('Working on it.')
  await expect(transcript(page)).toContainText(RESUMED_NOTE)
  await expect(transcript(page)).toContainText(RESUME_PROMPT)
  await expect(transcript(page)).toContainText('Done.')
  await expect(
    page.getByRole('main').getByRole('region', { name: 'Needs you' }).locator(`[data-task-id="${id}"]`),
  ).toHaveCount(0)
})

test('a question survives a restart, and its answer resumes the agent', async ({ page, request, setiServer }) => {
  test.skip(SPLIT_NODE, 'a separate node keeps the asking turn and asks the restarted server again')
  const asker = await askingAgent(request, 'Asker', PUSH_PROMPT)
  await setiServer.restart()

  const after = await apiData<Task>(request, `/tasks/${asker.id}`)
  expect(after).toMatchObject({ status: 'interrupted', blocked: `Asks a question: ${PUSH_QUESTION}` })
  await page.goto('/#requests')
  await agentQuestions(page, asker).getByRole('radio', { name: 'Yes' }).click()
  await page.getByRole('button', { name: 'Submit all' }).click()

  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${asker.id}`)).status).toBe('idle')
  expect((await apiData<Task>(request, `/tasks/${asker.id}`)).blocked).toBeNull()
  expect(await lastReply(request, asker.id)).toBe('Done.')
  await page.goto(`/#agents/${asker.id}`)
  await expect(transcript(page)).toContainText("Seti restarted while you waited for the user's answers")
  await expect(transcript(page)).toContainText(PUSH_QUESTION)
  await expect(transcript(page)).toContainText('Answer: Yes')
})

test('an agent that was not working is left as it was', async ({ request, setiServer }) => {
  const response = await request.post('/api/tasks', {
    data: { title: unique('Idle'), prompt: 'Say hello', cwd: paths.checkout, sandbox: false },
  })
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  await setiServer.restart()
  expect((await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  const { messages } = await apiData<MessagePage>(request, `/tasks/${id}/messages?limit=50`)
  expect(messages.filter((row) => row.kind === 'prompt')).toHaveLength(1)
})

test('a restart keeps a running turn going when agents run in a separate node', async ({ request, setiServer }) => {
  test.skip(!SPLIT_NODE, 'only a separate node keeps a turn across a restart')
  const id = await startWorkingAgent(request)
  await setiServer.restart()

  expect((await apiData<Task>(request, `/tasks/${id}`)).status).toBe('running')
  expect((await request.post(`/api/tasks/${id}/stop`)).ok()).toBe(true)
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('stopped')
  const { messages } = await apiData<MessagePage>(request, `/tasks/${id}/messages?limit=50`)
  expect(messages.filter((row) => row.kind === 'prompt')).toHaveLength(1)
  expect(messages.filter((row) => row.kind === 'sdk' && row.payload.type === 'assistant')).toHaveLength(1)
  expect(JSON.stringify(messages)).not.toContain(RESUMED_NOTE)
})
