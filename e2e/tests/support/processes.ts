import path from 'node:path'
import type { APIRequestContext } from '@playwright/test'
import type { Envelope, Task } from '@seti/shared'
import { paths } from './env.js'
import { SHELL_PROMPT } from './fake-claude.js'
import { expect, unique } from './fixtures.js'

/** Seti runs agents through the suite's fake Claude Code, which starts real background shells. */
export const FAKE_CLAUDE_ENV = { SETI_SDK_MODULE: path.join(import.meta.dirname, 'fake-claude.ts') }

/** Starts an agent whose first turn leaves a background shell running, and returns its id. */
export async function startShellAgent(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/tasks', {
    data: { title: unique('Dev server'), prompt: `Please ${SHELL_PROMPT}`, cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  return ((await response.json()) as Envelope<Task>).data.id
}
