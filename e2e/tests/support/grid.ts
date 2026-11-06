import type { APIRequestContext, Locator, Page } from '@playwright/test'
import type { Envelope, Task, WorkspaceEntry, WorkspaceGrid } from '@seti/shared'
import { paths } from './env.js'
import { apiData, expect } from './fixtures.js'

/** Starts an agent on the fake Claude Code, which answers each message with "Done.". */
export async function startAgent(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post('/api/tasks', {
    data: { title, prompt: `Please greet as ${title}`, cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  return id
}

export const grid = (page: Page) => page.getByTestId('agent-grid')
export const items = (page: Page) => page.locator('[data-grid-item]')
export const panelOf = (page: Page, title: string) =>
  items(page).filter({ has: page.getByRole('heading', { name: title, exact: true }) })
export const focusedPanel = (page: Page) => page.locator('[data-grid-panel][data-grid-focused="true"]')
export const status = (page: Page) => page.locator('#agent-grid-announcer')
export const toolbar = (page: Page) => page.getByRole('group', { name: 'Grid layout' })

export async function boxOf(locator: Locator) {
  const found = await locator.boundingBox()
  expect(found, 'bounding box').not.toBeNull()
  return found ?? { x: 0, y: 0, width: 0, height: 0 }
}

/** The first workspace's grid as the server keeps it. */
export async function mainGrid(request: APIRequestContext): Promise<WorkspaceGrid | undefined> {
  const [main] = await apiData<WorkspaceEntry[]>(request, '/workspaces')
  return (await apiData<WorkspaceGrid[]>(request, '/mods/grid/layouts')).find((g) => g.workspace_id === main?.id)
}

/** A panel's place and size in grid units, as [x, y, w, h]. */
export const rectOf = async (item: Locator) =>
  item.evaluate((element) => ['x', 'y', 'w', 'h'].map((key) => Number(element.getAttribute(`data-${key}`))))
