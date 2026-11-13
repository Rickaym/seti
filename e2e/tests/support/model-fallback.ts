import fs from 'node:fs'
import path from 'node:path'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import type { Envelope, Task } from '@seti/shared'
import { openAgentSettings } from './agent-settings.js'
import { paths } from './env.js'
import { CVP_URL, fallbackPrompt, MODEL_PROMPT } from './fake-fallback.js'
import { releaseStep } from './fake-steps.js'
import { expect, unique } from './fixtures.js'

const NOTICE_TEXT =
  'Claude Code switched this agent from Opus 5.5 to Opus 4.8 after a cyber safeguard flagged a request.'

/** Starts an agent whose turn trips the cyber safeguard; the turn holds until `release` runs. */
export async function startFallbackAgent(page: Page, request: APIRequestContext) {
  const gate = fs.mkdtempSync(path.join(paths.root, 'fallback-gate-'))
  const response = await request.post('/api/tasks', {
    data: { title: unique('Fallback'), prompt: fallbackPrompt(gate), cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await page.goto(`/#agents/${id}`)
  return {
    id,
    release: () => {
      releaseStep(gate, 0)
    },
  }
}

export const fallbackNotice = (page: Page): Locator => page.getByTestId('model-fallback-notice')

/** The notice says what happened, names the category and links the explanation and the program. */
export async function expectNotice(page: Page): Promise<Locator> {
  const notice = fallbackNotice(page)
  await expect(notice).toContainText(NOTICE_TEXT)
  await expect(notice).toContainText('Category: cyber')
  await expect(notice.getByRole('link', { name: CVP_URL })).toHaveAttribute('href', CVP_URL)
  const program = notice.getByRole('link', { name: 'Verification', exact: true })
  await expect(program).toHaveAttribute('href', CVP_URL)
  return notice
}

/** The Session tab shows the fallback model with its mark and a Switch back button. */
export async function expectSettingsFallback(page: Page): Promise<void> {
  const dialog = await openAgentSettings(page, 'Session')
  const model = dialog.getByTestId('task-model')
  await expect(model).toContainText('claude-opus-4-8')
  await expect(model.getByTestId('fallback-mark')).toBeVisible()
  await expect(model.getByRole('button', { name: 'Switch back' })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
}

/** Switch back sends /model once the turn has ended; a later start on Opus 5.5 clears the mark. */
export async function switchBack(page: Page, request: APIRequestContext, id: string, mark: Locator) {
  const button = fallbackNotice(page).getByRole('button', { name: 'Switch back' })
  await button.click()
  const main = page.getByRole('main')
  await expect(main.getByText('/model claude-opus-5-5', { exact: true })).toBeVisible()
  await expect(main.getByText('Set model to claude-opus-5-5')).toBeVisible()
  await expect(mark).toBeVisible()
  const sent = await request.post(`/api/tasks/${id}/messages`, { data: { prompt: MODEL_PROMPT } })
  expect(sent.ok(), 'POST messages').toBe(true)
  await expect(main.getByText('Running on claude-opus-5-5.')).toBeVisible()
  await expect(mark).toHaveCount(0)
  await expect(button).toHaveCount(0)
  await expect(fallbackNotice(page)).toContainText(NOTICE_TEXT)
}
