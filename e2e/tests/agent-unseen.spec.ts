import type { APIRequestContext, Locator, Page } from '@playwright/test'
import type { Task } from '@seti/shared'
import { apiData, expect, test } from './support/fixtures.js'
import { gridStorage } from './support/grid-perf.js'
import { startAgent } from './support/many-prs.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const rowOf = (page: Page, id: string) => page.getByRole('main').locator(`[data-task-id="${id}"]`)
const dot = (scope: Locator) => scope.getByRole('img', { name: 'unseen' })
const unseen = async (request: APIRequestContext, id: string) => (await apiData<Task>(request, `/tasks/${id}`)).unseen

async function send(request: APIRequestContext, id: string, prompt: string): Promise<void> {
  const response = await request.post(`/api/tasks/${id}/messages`, { data: { prompt } })
  expect(response.ok(), `POST /api/tasks/${id}/messages`).toBe(true)
}

async function markSeen(request: APIRequestContext, id: string): Promise<void> {
  const response = await request.post(`/api/tasks/${id}/seen`, { data: {} })
  expect(response.ok(), `POST /api/tasks/${id}/seen`).toBe(true)
}

test('an agent that finishes while another is open shows a dot until it is opened', async ({ page, request }) => {
  const first = await startAgent(request, 'Dot first')
  const second = await startAgent(request, 'Dot second')
  await page.goto(`/#agents/${second.id}`)
  await expect(dot(rowOf(page, first.id))).toBeVisible()
  await expect(dot(rowOf(page, first.id))).toHaveAttribute('title', /finished since you last looked/)
  await expect.poll(async () => unseen(request, second.id)).toBe(false)
  await expect(dot(rowOf(page, second.id))).toHaveCount(0)

  await rowOf(page, first.id).getByRole('button').click()
  await expect(dot(rowOf(page, first.id))).toHaveCount(0)
  await expect.poll(async () => unseen(request, first.id)).toBe(false)

  await rowOf(page, second.id).getByRole('button').click()
  await send(request, first.id, 'Please wrap up')
  await expect(dot(rowOf(page, first.id))).toBeVisible()
  await page.getByRole('main').getByRole('button', { name: 'Filter agents' }).click()
  const filter = page.getByRole('main').getByRole('searchbox', { name: 'Filter agents' })
  await filter.fill('unseen dot')
  await expect(rowOf(page, first.id)).toBeVisible()
  await expect(rowOf(page, second.id)).toHaveCount(0)
  await filter.fill('')

  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.fill('One more thing')
  await reply.press('Enter')
  const transcript = page.getByRole('main').getByRole('region', { name: 'Transcript' })
  await expect(transcript.getByText('One more thing')).toBeVisible()
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${second.id}`)).status).toBe('idle')
  await expect.poll(async () => unseen(request, second.id)).toBe(false)
  await expect(dot(rowOf(page, second.id))).toHaveCount(0)

  await page.locator('body').press('Alt+u')
  await expect(page).toHaveURL(new RegExp(`#agents/${first.id}$`))
  await expect(dot(rowOf(page, first.id))).toHaveCount(0)
  await expect.poll(async () => unseen(request, first.id)).toBe(false)
})

test('the palette opens the next unseen agent', async ({ page, request }) => {
  const agent = await startAgent(request, 'Unseen palette')
  await page.goto('/#settings')
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').fill('>next unseen')
  await expect(page.getByRole('dialog', { name: 'Search Seti' }).getByText('Next unseen agent')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`#agents/${agent.id}$`))
  await expect.poll(async () => unseen(request, agent.id)).toBe(false)
})

test('a grid panel shows the dot while it streams nothing, and clears once resumed', async ({ page, request }) => {
  const agents = [
    await startAgent(request, 'Unseen grid 1'),
    await startAgent(request, 'Unseen grid 2'),
    await startAgent(request, 'Unseen grid 3'),
    await startAgent(request, 'Unseen grid 4'),
  ]
  const paused = agents[3]
  if (paused === undefined) {
    throw new Error('the fourth agent did not start')
  }
  await markSeen(request, paused.id)
  await page.addInitScript(
    (stored) => {
      try {
        if (sessionStorage.getItem('unseen-grid') === null) {
          sessionStorage.setItem('unseen-grid', '1')
          localStorage.setItem('seti.agents.grid', stored)
        }
      } catch {
        // Pages without storage, such as about:blank, keep no grid.
      }
    },
    gridStorage(agents.map((agent) => agent.id)),
  )
  await page.goto('/#agents')
  const panel = page.locator('[data-grid-panel]').filter({ has: page.getByRole('heading', { name: paused.title }) })
  await expect(panel.getByRole('button', { name: 'Resume' })).toBeVisible()
  for (const agent of agents.slice(0, 3)) {
    await expect.poll(async () => unseen(request, agent.id)).toBe(false)
  }
  await expect(dot(panel)).toHaveCount(0)

  await send(request, paused.id, 'Please finish up')
  await expect(dot(panel)).toBeVisible()
  await expect(dot(rowOf(page, paused.id))).toBeVisible()
  expect(await unseen(request, paused.id)).toBe(true)

  await panel.getByRole('button', { name: 'Resume' }).click()
  await expect(panel.getByTestId('agent-header')).toBeVisible()
  await expect.poll(async () => unseen(request, paused.id)).toBe(false)
  await expect(dot(panel)).toHaveCount(0)
  await expect(dot(rowOf(page, paused.id))).toHaveCount(0)
})
