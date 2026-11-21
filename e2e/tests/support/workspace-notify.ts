import type { APIRequestContext, Page } from '@playwright/test'
import type { EaInboxDelivered, EaInboxItem, Envelope, NotifyScopeInput, Task, Workspace } from '@seti/shared'
import { REPLY_TOAST_MS, clearEaReplies, eaToast } from './ea-replies.js'
import { EA_HEADERS, paths } from './env.js'
import { FAIL_PROMPT } from './fake-claude.js'
import { apiData, expect, toasts, unique } from './fixtures.js'
import type { PushService } from './push.js'
import { createWorkspace, switchWorkspace, workspaceItem, workspaceSwitcher } from './workspaces.js'

let turns = 0

/** Starts an agent in the workspace whose first turn fails, so it needs the user. */
async function failAgent(request: APIRequestContext, title: string, workspace: Workspace): Promise<string> {
  turns += 1
  const prompt = `${FAIL_PROMPT} ${unique('scope')} ${String(turns)}`
  const response = await request.post('/api/tasks', {
    data: { title, prompt, cwd: paths.checkout, sandbox: false, workspace_id: workspace.id },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('error')
  return id
}

/** Waits until Seti answered a scope change of this device that `matches`. */
async function scopeSaved(page: Page, matches: (change: NotifyScopeInput) => boolean): Promise<void> {
  await page.waitForResponse((res) => {
    const req = res.request()
    return req.method() === 'PUT' && req.url().endsWith('/scope') && matches(req.postDataJSON() as NotifyScopeInput)
  })
}

/** Hides or shows the page as switching apps does; hidden, it stops reporting and pushes reach it. */
async function setVisible(page: Page, visible: boolean): Promise<void> {
  const reported = page.waitForResponse((res) => {
    const req = res.request()
    return (
      req.url().endsWith('/api/notifications/focus') && (req.postDataJSON() as { active: boolean }).active === visible
    )
  })
  await page.evaluate(
    (state) => {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    },
    visible ? 'visible' : 'hidden',
  )
  await reported
}

/**
 * The page tells Seti its workspace once when it loads and again only when the workspace changes:
 * moving around the app, polls and showing the page again on the same workspace send nothing.
 */
export async function reportsOncePerChange(page: Page, request: APIRequestContext): Promise<void> {
  const tag = unique('report')
  await createWorkspace(request, `Report A ${tag}`)
  const b = await createWorkspace(request, `Report B ${tag}`)
  const reports: NotifyScopeInput[] = []
  page.on('request', (req) => {
    if (req.method() === 'PUT' && req.url().endsWith('/scope')) {
      reports.push(req.postDataJSON() as NotifyScopeInput)
    }
  })
  const loaded = scopeSaved(page, () => true)
  await page.goto('/#agents')
  await loaded
  expect(reports).toHaveLength(1)

  for (const view of ['#settings/resources', '#agents', '#settings/notifications', '#agents']) {
    await page.evaluate((hash) => {
      window.location.hash = hash
    }, view)
    await expect(page).toHaveURL(new RegExp(`${view}$`))
  }
  await setVisible(page, false)
  await setVisible(page, true)
  expect(reports).toHaveLength(1)

  const onB = scopeSaved(page, (change) => change.workspace_id === b.id)
  await switchWorkspace(page, b.name)
  await onB
  await setVisible(page, false)
  await setVisible(page, true)
  expect(reports.map((report) => report.workspace_id)).toEqual([reports[0]?.workspace_id, b.id])

  const reloaded = scopeSaved(page, (change) => change.workspace_id === b.id)
  await page.reload()
  await reloaded
  expect(reports).toHaveLength(3)
}

const workspaceOnly = (page: Page) =>
  page.getByRole('main').getByRole('button', { name: 'Workspace only', exact: true })

/**
 * Two workspaces: with this device on B, an agent in A that needs the user raises no toast and
 * no push here while the switcher counts it; with "Active workspace only" off, both arrive.
 * Returns the agents it started.
 */
export async function keepsToTheOpenWorkspace(
  page: Page,
  request: APIRequestContext,
  service: PushService,
): Promise<string[]> {
  const tag = unique('scope')
  const a = await createWorkspace(request, `Notify A ${tag}`)
  const b = await createWorkspace(request, `Notify B ${tag}`)
  const pushesFor = (id: string) => service.pushes.filter((push) => push.payload.tag === id)

  await page.goto('/#settings/notifications')
  const push = page.getByRole('main').getByRole('button', { name: 'Push', exact: true })
  await push.scrollIntoViewIfNeeded()
  await push.click()
  await expect(push).toHaveAttribute('aria-pressed', 'true')
  await expect(workspaceOnly(page)).toHaveAttribute('aria-pressed', 'true')

  await page.goto('/#agents')
  const onB = scopeSaved(page, (change) => change.workspace_id === b.id)
  await switchWorkspace(page, b.name)
  await onB

  const quietTitle = `Quiet in A ${tag}`
  const quiet = await failAgent(request, quietTitle, a)
  await expect(workspaceSwitcher(page).locator('[data-needs-you-elsewhere]')).toHaveText(/^\d+$/)
  await workspaceSwitcher(page).click()
  await expect(workspaceItem(page, a.name)).toHaveAccessibleName(`${a.name}, 1 needs you`)
  await page.keyboard.press('Escape')
  await expect(toasts(page).filter({ hasText: quietTitle })).toHaveCount(0)

  await setVisible(page, false)
  const away = await failAgent(request, `Away in A ${tag}`, a)
  const here = await failAgent(request, `Here in B ${tag}`, b)
  await expect.poll(() => pushesFor(here).length).toBe(1)
  expect(pushesFor(here)[0]?.payload).toMatchObject({ kind: 'needs_you', url: `/#agents/${here}` })
  expect(pushesFor(quiet)).toEqual([])
  expect(pushesFor(away)).toEqual([])

  await setVisible(page, true)
  await page.goto('/#settings/notifications')
  await workspaceOnly(page).scrollIntoViewIfNeeded()
  const off = scopeSaved(page, (change) => change.workspace_only === false)
  await workspaceOnly(page).click()
  await off
  await expect(workspaceOnly(page)).toHaveAttribute('aria-pressed', 'false')
  await expect(toasts(page).filter({ hasText: quietTitle })).toHaveCount(0)

  const loudTitle = `Loud in A ${tag}`
  const loud = await failAgent(request, loudTitle, a)
  await expect(toasts(page).filter({ hasText: loudTitle })).toBeVisible()
  expect(pushesFor(loud)).toEqual([])

  await setVisible(page, false)
  const pushed = await failAgent(request, `Pushed from A ${tag}`, a)
  await expect.poll(() => pushesFor(pushed).length).toBe(1)
  expect(pushesFor(pushed)[0]?.payload).toMatchObject({ kind: 'needs_you', url: `/#agents/${pushed}` })
  return [quiet, away, here, loud, pushed]
}

async function asBot<T>(request: APIRequestContext, path: string, data?: unknown): Promise<T> {
  const response =
    data === undefined
      ? await request.get(path, { headers: EA_HEADERS })
      : await request.post(path, { headers: EA_HEADERS, data })
  expect(response.ok(), path).toBe(true)
  return ((await response.json()) as Envelope<T>).data
}

/** An agent in the workspace the EA watches, whose next turn fails once it is watched. */
async function watchedFailure(request: APIRequestContext, title: string, workspace: Workspace): Promise<string> {
  const id = await failAgent(request, title, workspace)
  expect((await request.post('/api/ea/watches', { data: { task_id: id, note: 'e2e' } })).ok()).toBe(true)
  const again = await request.post(`/api/tasks/${id}/messages`, {
    data: { prompt: `${FAIL_PROMPT} ${unique('watched')}` },
  })
  expect(again.ok(), await again.text()).toBe(true)
  return id
}

/** Waits for the EA's item about the agent and delivers it in the EA chat, as the EA does. */
async function deliverItemAbout(request: APIRequestContext, taskId: string): Promise<EaInboxDelivered['items']> {
  let item: EaInboxItem | undefined
  await expect
    .poll(async () => {
      item = (await asBot<EaInboxItem[]>(request, '/api/ea/inbox/due')).find((each) => each.task_id === taskId)
      return item !== undefined
    })
    .toBe(true)
  const ids = item === undefined ? [] : [item.id]
  return (await asBot<EaInboxDelivered>(request, '/api/ea/inbox/deliver', { ids, via: 'chat', notify: ids })).items
}

/**
 * The EA's items follow the same rule: with this page on B, its item about a watched agent in A
 * raises no toast here; with "Active workspace only" off, it does. Returns the agents it started.
 */
export async function eaKeepsToTheOpenWorkspace(page: Page, request: APIRequestContext): Promise<string[]> {
  const tag = unique('ea-scope')
  const a = await createWorkspace(request, `EA A ${tag}`)
  const b = await createWorkspace(request, `EA B ${tag}`)
  await page.goto('/#agents')
  const onB = scopeSaved(page, (change) => change.workspace_id === b.id)
  await switchWorkspace(page, b.name)
  await onB

  const quietTitle = `EA quiet ${tag}`
  const quiet = await watchedFailure(request, quietTitle, a)
  expect((await deliverItemAbout(request, quiet)).map((item) => item.route)).toEqual(['digest'])

  await page.goto('/#settings/notifications')
  await workspaceOnly(page).scrollIntoViewIfNeeded()
  const off = scopeSaved(page, (change) => change.workspace_only === false)
  await workspaceOnly(page).click()
  await off
  await setVisible(page, true)

  const loudTitle = `EA loud ${tag}`
  const loud = await watchedFailure(request, loudTitle, a)
  expect((await deliverItemAbout(request, loud)).map((item) => item.route)).toEqual(['toast'])
  await expect(eaToast(page, `${loudTitle} stopped with an error`)).toBeVisible({ timeout: REPLY_TOAST_MS })
  await expect(eaToast(page, quietTitle)).toHaveCount(0)
  return [quiet, loud]
}

/** Removes what the scenario left: its agents, their watches, the EA's messages and push devices. */
export async function clearScenario(request: APIRequestContext, agents: readonly string[]): Promise<void> {
  if (agents.length > 0) {
    await request.post('/api/tasks/archive', { data: { task_ids: agents, remove_worktree: false } })
  }
  for (const id of agents) {
    await request.delete(`/api/ea/watches/${id}`)
  }
  await clearEaReplies(request)
  const { devices } = await apiData<{ devices: { device_id: string }[] }>(request, '/notifications')
  for (const device of devices) {
    await request.delete(`/api/notifications/devices/${device.device_id}`)
  }
}
