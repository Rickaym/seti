import type { APIRequestContext, Page } from '@playwright/test'
import type { AttentionState, Envelope, Task } from '@seti/shared'
import { paths } from './env.js'
import { ASK_PROMPT } from './fake-claude.js'
import { apiData, expect } from './fixtures.js'
import { FAKE_CLAUDE_ENV } from './processes.js'

/** The away time the brief specs' server uses, so a short hide counts as leaving. */
const AWAY_MS = 2000

export const BRIEF_ENV = { ...FAKE_CLAUDE_ENV, SETI_AWAY_MS: String(AWAY_MS) }

/** Shows or hides the page as switching apps does; the page reports its focus either way. */
async function setVisible(page: Page, visible: boolean): Promise<void> {
  const reported = page.waitForRequest((req) => req.url().endsWith('/api/notifications/focus'))
  await page.evaluate((shown) => {
    Object.defineProperty(document, 'visibilityState', { value: shown ? 'visible' : 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  }, visible)
  expect((await reported).postDataJSON()).toMatchObject({ active: visible })
}

/** Starts an agent and waits for its turn to end; `ask` ends it on a question for the user. */
export async function finishedAgent(request: APIRequestContext, title: string, ask = false): Promise<string> {
  const prompt = ask ? ASK_PROMPT : `Say hello for ${title}`
  const response = await request.post('/api/tasks', {
    data: { title, prompt, cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  return id
}

/** Leaves the page hidden past the away time while `work` runs, then comes back to it. */
export async function awayWhile(page: Page, work: () => Promise<void>): Promise<void> {
  await setVisible(page, false)
  const left = Date.now()
  await work()
  await page.waitForTimeout(Math.max(0, AWAY_MS + 500 - (Date.now() - left)))
  await setVisible(page, true)
}

export const briefToast = (page: Page) => page.getByTestId('attention-brief')

export const waitingBrief = async (request: APIRequestContext) =>
  (await apiData<AttentionState>(request, '/attention')).brief
