import type { Locator } from '@playwright/test'
import { expect, test, unique } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { agentRow, createWorkspace, seedAgent, workspaceItem, workspaceSwitcher } from './support/workspaces.js'

const TARGET_PX = 44

async function height(locator: Locator): Promise<number> {
  return Math.round((await locator.boundingBox())?.height ?? 0)
}

test('the workspace switcher on a phone is touch-sized, fits, and switches the list', async ({ page, request }) => {
  const tag = unique('phone')
  const other = await createWorkspace(request, `Phone ${tag}`)
  const main = await seedAgent(`Phone main ${tag}`)
  const away = await seedAgent(`Phone away ${tag}`, { workspaceId: other.id })
  await page.goto('/#agents')
  await expect(agentRow(page, main)).toBeVisible()
  await expect(agentRow(page, away)).toHaveCount(0)
  expect(await height(workspaceSwitcher(page))).toBeGreaterThanOrEqual(TARGET_PX)
  await expectFitsPhone(page, 'workspace switcher')

  await workspaceSwitcher(page).tap()
  for (const item of [
    workspaceItem(page, 'Main'),
    workspaceItem(page, other.name),
    page.getByRole('menuitem', { name: 'New workspace' }),
    page.getByRole('menuitem', { name: 'Rename' }),
    page.getByRole('menuitem', { name: 'Delete' }),
  ]) {
    await expect(item).toBeInViewport({ ratio: 0.99 })
    await expect.poll(async () => height(item)).toBeGreaterThanOrEqual(TARGET_PX)
  }
  await workspaceItem(page, other.name).tap()
  await expect(workspaceSwitcher(page)).toHaveAccessibleName(`Workspace: ${other.name}`)
  await expect(agentRow(page, away)).toBeVisible()
  await expect(agentRow(page, main)).toHaveCount(0)
  await expectFitsPhone(page, 'list of another workspace')
})
