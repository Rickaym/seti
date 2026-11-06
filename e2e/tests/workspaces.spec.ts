import type { Page } from '@playwright/test'
import type { Task, WorkspaceEntry } from '@seti/shared'
import { openAgentSettings, settingsDialog } from './support/agent-settings.js'
import { apiData, expect, test, toasts, unique } from './support/fixtures.js'
import {
  agentRow,
  createWorkspace,
  seedAgent,
  switchWorkspace,
  workspaceItem,
  workspaceSwitcher,
} from './support/workspaces.js'

const MAIN = 'Main'

async function runCommand(page: Page, query: string, title: string): Promise<void> {
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Search Seti' })
  await palette.getByRole('combobox').fill(query)
  await palette
    .getByRole('option', { name: new RegExp(`^${title}`) })
    .first()
    .click()
  await expect(palette).toBeHidden()
}

const panelOf = (page: Page, title: string) =>
  page.locator('[data-grid-item]').filter({ has: page.getByRole('heading', { name: title, exact: true }) })

test('a new workspace starts empty, lists only its agents and keeps its own pinned ones', async ({ page, request }) => {
  const tag = unique('ws')
  const mainPinned = await seedAgent(`Main pinned ${tag}`, { pinned: true })
  await page.goto('/#agents')
  await expect(agentRow(page, mainPinned)).toBeVisible()
  await expect(workspaceSwitcher(page)).toHaveAccessibleName(`Workspace: ${MAIN}`)

  await workspaceSwitcher(page).click()
  await page.getByRole('menuitem', { name: 'New workspace' }).click()
  const dialog = page.getByRole('dialog', { name: 'New workspace' })
  await expect(dialog.getByRole('textbox', { name: 'Workspace name' })).toBeFocused()
  await page.keyboard.type(`Side ${tag}`)
  await page.keyboard.press('Enter')
  await expect(workspaceSwitcher(page)).toHaveAccessibleName(`Workspace: Side ${tag}`)
  await expect(agentRow(page, mainPinned)).toHaveCount(0)
  await expect(page.getByRole('main').getByText('No agents yet.')).toBeVisible()

  const side = (await apiData<WorkspaceEntry[]>(request, '/workspaces')).find((w) => w.name === `Side ${tag}`)
  const sideId = side?.id ?? ''
  const sideOther = await seedAgent(`Side other ${tag}`, { workspaceId: sideId })
  const sidePinned = await seedAgent(`Side pinned ${tag}`, { workspaceId: sideId, pinned: true })
  await expect(agentRow(page, sidePinned).getByLabel('Pinned')).toBeVisible({ timeout: 15_000 })
  const ids = async () =>
    page.locator('[data-task-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-task-id')))
  await expect.poll(ids).toEqual([sidePinned, sideOther])

  await switchWorkspace(page, MAIN)
  await expect(agentRow(page, mainPinned).getByLabel('Pinned')).toBeVisible()
  await expect(agentRow(page, sidePinned)).toHaveCount(0)
  await page.reload()
  await expect(workspaceSwitcher(page)).toHaveAccessibleName(`Workspace: ${MAIN}`)
  await switchWorkspace(page, `Side ${tag}`)
  await page.reload()
  await expect(workspaceSwitcher(page)).toHaveAccessibleName(`Workspace: Side ${tag}`)
  await expect(agentRow(page, sideOther)).toBeVisible()
})

test('the cog and the palette move an agent, and the list goes along with it', async ({ page, request }) => {
  const tag = unique('move')
  const target = await createWorkspace(request, `Moved to ${tag}`)
  const id = await seedAgent(`Mover ${tag}`)
  await page.goto(`/#agents/${id}`)
  await expect(workspaceSwitcher(page)).toHaveAccessibleName(`Workspace: ${MAIN}`)

  const dialog = await openAgentSettings(page)
  await dialog.getByRole('combobox', { name: 'Workspace' }).selectOption({ label: target.name })
  await expect(toasts(page).filter({ hasText: `Moved to ${target.name}` })).toBeVisible()
  await expect(workspaceSwitcher(page)).toHaveAccessibleName(`Workspace: ${target.name}`)
  await expect(agentRow(page, id)).toBeVisible()
  expect((await apiData<Task>(request, `/tasks/${id}`)).workspace_id).toBe(target.id)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await runCommand(page, '>move to workspace', 'Move to workspace')
  const select = settingsDialog(page).getByRole('combobox', { name: 'Workspace' })
  await expect(select).toBeFocused()
  await select.selectOption({ label: MAIN })
  await expect(workspaceSwitcher(page)).toHaveAccessibleName(`Workspace: ${MAIN}`)
  await expect(agentRow(page, id)).toBeVisible()
})

test('the palette switches workspace and going to an agent elsewhere opens its workspace', async ({
  page,
  request,
}) => {
  const tag = unique('palette')
  const other = await createWorkspace(request, `Palette ${tag}`)
  const elsewhere = await seedAgent(`Elsewhere ${tag}`, { workspaceId: other.id })
  await page.goto('/#settings')
  await runCommand(page, `>switch to palette ${tag}`, `Switch to ${other.name}`)
  await expect(page).toHaveURL(/#agents$/)
  await expect(workspaceSwitcher(page)).toHaveAccessibleName(`Workspace: ${other.name}`)
  await expect(agentRow(page, elsewhere)).toBeVisible()

  await runCommand(page, `>switch to ${MAIN}`, `Switch to ${MAIN}`)
  await expect(workspaceSwitcher(page)).toHaveAccessibleName(`Workspace: ${MAIN}`)
  await expect(agentRow(page, elsewhere)).toHaveCount(0)

  await runCommand(page, `Elsewhere ${tag}`, `Elsewhere ${tag}`)
  await expect(page).toHaveURL(new RegExp(`#agents/${elsewhere}$`))
  await expect(workspaceSwitcher(page)).toHaveAccessibleName(`Workspace: ${other.name}`)
  await expect(agentRow(page, elsewhere)).toBeVisible()
})

test('each workspace keeps its own grid', async ({ page, request }) => {
  const tag = unique('grid')
  const other = await createWorkspace(request, `Grid ${tag}`)
  const hereTitle = `Grid here ${tag}`
  const thereTitle = `Grid there ${tag}`
  const here = await seedAgent(hereTitle)
  const there = await seedAgent(thereTitle, { workspaceId: other.id })
  await page.goto(`/#agents/${here}`)
  await page.getByRole('button', { name: 'Open in grid' }).click()
  await expect(panelOf(page, hereTitle)).toHaveCount(1)

  await switchWorkspace(page, other.name)
  await expect(page.getByTestId('agent-grid')).toBeVisible()
  await expect(panelOf(page, hereTitle)).toHaveCount(0)
  await agentRow(page, there).getByRole('button').first().click()
  await expect(panelOf(page, thereTitle)).toHaveCount(1)

  await switchWorkspace(page, MAIN)
  await expect(panelOf(page, hereTitle)).toHaveCount(1)
  await expect(panelOf(page, thereTitle)).toHaveCount(0)
  await page.reload()
  await expect(panelOf(page, hereTitle)).toHaveCount(1)
  await switchWorkspace(page, other.name)
  await expect(panelOf(page, thereTitle)).toHaveCount(1)
  await expect(panelOf(page, hereTitle)).toHaveCount(0)
})

test('the switcher marks other workspaces that need you and the status bar counts them all', async ({
  page,
  request,
}) => {
  const tag = unique('needs')
  const failing = await createWorkspace(request, `Failing ${tag}`)
  const quiet = await createWorkspace(request, `Quiet ${tag}`)
  const failed = await seedAgent(`Failed ${tag}`, { workspaceId: failing.id, status: 'error' })
  await page.goto('/#agents')
  await switchWorkspace(page, quiet.name)
  await expect(page.getByRole('main').getByRole('region', { name: 'Needs you' })).toHaveCount(0)

  await workspaceSwitcher(page).click()
  await expect(workspaceItem(page, failing.name)).toHaveAccessibleName(`${failing.name}, 1 needs you`)
  await expect(workspaceItem(page, quiet.name)).toHaveAccessibleName(quiet.name)
  await page.keyboard.press('Escape')

  const item = page.getByRole('contentinfo').getByRole('button', { name: /agents? needs? you$/ })
  await expect(item).toHaveText(/^\d+ need you$/)
  await item.click()
  await expect(workspaceSwitcher(page)).toHaveAccessibleName(`Workspace: ${failing.name}`)
  await expect(
    page.getByRole('main').getByRole('region', { name: 'Needs you' }).locator(`[data-task-id="${failed}"]`),
  ).toBeVisible()
})

test.describe('deleting a workspace', () => {
  test.use({ allowedHttpStatuses: [409] })

  test('is refused while it holds agents, archived ones too, and goes once it is empty', async ({ page, request }) => {
    const tag = unique('delete')
    const doomed = await createWorkspace(request, `Doomed ${tag}`)
    const id = await seedAgent(`Doomed agent ${tag}`, { workspaceId: doomed.id })
    const archived = await request.post(`/api/tasks/${id}/archive`, { data: { remove_worktree: false } })
    expect(archived.ok(), 'archive').toBe(true)
    await page.goto('/#agents')
    await switchWorkspace(page, doomed.name)

    const remove = async () => {
      await workspaceSwitcher(page).click()
      await page.getByRole('menuitem', { name: 'Delete' }).click()
      await page.getByRole('dialog', { name: 'Delete workspace' }).getByRole('button', { name: 'Delete' }).click()
    }
    await remove()
    await expect(
      toasts(page).filter({ hasText: `Move or delete the 1 agent in "${doomed.name}" first, archived ones included` }),
    ).toBeVisible()

    await page.getByRole('button', { name: 'More list actions' }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Archived' }).click()
    await page.getByRole('main').locator(`[data-task-id="${id}"]`).click()
    await page.getByRole('main').getByRole('combobox', { name: 'Workspace' }).selectOption({ label: MAIN })
    await expect(workspaceSwitcher(page)).toHaveAccessibleName(`Workspace: ${MAIN}`)
    expect((await apiData<Task>(request, `/tasks/${id}`)).workspace_id).not.toBe(doomed.id)

    await page.getByRole('main').getByRole('button', { name: 'Active', exact: true }).click()
    await switchWorkspace(page, doomed.name)
    await remove()
    await expect(toasts(page).filter({ hasText: `Deleted workspace "${doomed.name}"` })).toBeVisible()
    await expect(workspaceSwitcher(page)).toHaveAccessibleName(`Workspace: ${MAIN}`)
  })
})

test('the switcher fits the narrowest list and cuts a long name short', async ({ page, request }) => {
  const long = await createWorkspace(request, unique('A workspace with a name far too long for the list'))
  await page.goto('/#agents')
  await switchWorkspace(page, long.name)
  const handle = page.getByRole('separator', { name: 'Resize agent list' })
  await handle.focus()
  await page.keyboard.press('Home')
  const trigger = workspaceSwitcher(page)
  const fit = await trigger.evaluate((element) => {
    const row = element.parentElement?.getBoundingClientRect()
    const box = element.getBoundingClientRect()
    const name = element.querySelector('.truncate')
    return {
      inside: row !== undefined && box.left >= row.left - 0.5 && box.right <= row.right + 0.5,
      cut: name !== null && name.scrollWidth > name.clientWidth,
    }
  })
  expect(fit).toEqual({ inside: true, cut: true })
})
