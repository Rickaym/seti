import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import type { APIRequestContext, Page } from '@playwright/test'
import type { Task } from '@seti/shared'
import { setiPrompt } from './fake-claude.js'
import { expect } from './fixtures.js'
import { askingAgent, lastToolResult } from './questions.js'

export const SECRET_NAME = 'AZURE_SPEECH_KEY'
export const SECRET_PURPOSE = 'For the speech tests'

/** A value built at run time, so no scanner takes it for a real one. */
export const fixtureValue = () => ['fixture', 'value', randomUUID()].join('-')

/** Starts an unsandboxed agent that calls ask_secret and waits until it holds the agent. */
export const secretAgent = async (request: APIRequestContext, name: string): Promise<Task> =>
  askingAgent(request, name, setiPrompt('ask_secret', { name: SECRET_NAME, purpose: SECRET_PURPOSE }))

/** The path ask_secret handed back, once the call returned. */
async function secretPath(request: APIRequestContext, taskId: string): Promise<string> {
  let file = ''
  await expect
    .poll(async () => {
      const found = /^The value of AZURE_SPEECH_KEY is in (\/\S+)\. Read it/.exec(await lastToolResult(request, taskId))
      file = found?.[1] ?? ''
      return file
    })
    .toMatch(/\/secrets\/AZURE_SPEECH_KEY$/)
  return file
}

/** The file holds the value, mode 600, and no transcript, question or page shows it. */
export async function expectKeptOut(page: Page, request: APIRequestContext, task: Task, value: string) {
  const file = await secretPath(request, task.id)
  expect(fs.readFileSync(file, 'utf8')).toBe(value)
  expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  expect(fs.statSync(file.replace(/\/[^/]+$/, '')).mode & 0o777).toBe(0o700)
  const transcript = await request.get(`/api/tasks/${task.id}/messages?limit=200`)
  expect(await transcript.text()).not.toContain(value)
  const asked = await request.get(`/api/questions?task_id=${task.id}&all=true`)
  expect(await asked.text()).toContain(SECRET_NAME)
  expect(await asked.text()).not.toContain(value)
  expect(await page.content()).not.toContain(value)
  await page.goto(`/#agents/${task.id}`)
  await expect(page.getByText('Called seti ask_secret.')).toBeVisible()
  expect(await page.content()).not.toContain(value)
}
