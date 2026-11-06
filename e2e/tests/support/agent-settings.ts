import type { Locator, Page } from '@playwright/test'
import { expect } from './fixtures.js'

/** The tabs of the agent settings, the most used first. */
export type SettingsSection = 'General' | 'Access' | 'Team' | 'Session'

/** Each tab's rows for an idle agent with no model, PRs or channels. */
const SECTIONS: readonly (readonly [SettingsSection, readonly string[]])[] = [
  ['General', ['Role', 'Workspace', 'Color', 'Notify', 'Directories']],
  ['Access', ['Credentials', 'Can reach', 'Isolation', 'Bypass', 'Rules']],
  ['Team', ['Group chat', 'Channels']],
  ['Session', ['Cost', 'Memory', 'CPU', 'Compaction']],
]

/** The open agent settings: the desktop popover or the phone sheet, found by their section tabs. */
export const settingsDialog = (page: Page): Locator =>
  page.getByRole('dialog').filter({ has: page.getByRole('tablist', { name: 'Sections' }) })

/** Switches the open agent settings to one tab. */
export async function showSection(dialog: Locator, section: SettingsSection): Promise<Locator> {
  const tab = dialog.getByRole('tab', { name: section, exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  return dialog.getByRole('tabpanel', { name: section })
}

/** Opens the agent settings from the cog in `scope` (the page's main area by default) on one tab. */
export async function openAgentSettings(
  page: Page,
  section: SettingsSection = 'General',
  scope: Locator = page.getByRole('main'),
): Promise<Locator> {
  await scope.getByRole('button', { name: 'Agent settings' }).first().click()
  const dialog = settingsDialog(page)
  await expect(dialog).toBeVisible()
  await showSection(dialog, section)
  return dialog
}

/** Opens the folded colour choices in the General tab. */
export async function expandColors(dialog: Locator): Promise<void> {
  const chip = dialog.getByRole('button', { name: /^Colour / })
  if ((await chip.getAttribute('aria-expanded')) !== 'true') {
    await chip.click()
  }
  await expect(chip).toHaveAttribute('aria-expanded', 'true')
}

/** Checks the agent settings in `dialog`: four tabs in order, each with its rows, then actions. */
export async function expectGroupedSettings(dialog: Locator): Promise<void> {
  const tabs = dialog.getByRole('tablist', { name: 'Sections' }).getByRole('tab')
  await expect(tabs).toHaveText(SECTIONS.map(([name]) => name))
  for (const [name, rows] of SECTIONS) {
    const panel = await showSection(dialog, name)
    await expect(panel.locator('dt')).toHaveText([...rows])
    const body = await panel.boundingBox()
    for (const action of ['Restart session', 'Fresh session', 'Archive']) {
      const button = dialog.getByRole('button', { name: action, exact: true })
      await expect(button, `${action} on ${name}`).toBeInViewport()
      const box = await button.boundingBox()
      expect(box?.y ?? 0, `${action} below ${name}`).toBeGreaterThanOrEqual((body?.y ?? 0) + (body?.height ?? 0) - 1)
    }
  }
  await expectLifecycleFooter(dialog)
}

/** Restart and Fresh side by side with their consequences, Archive apart below them. */
async function expectLifecycleFooter(dialog: Locator): Promise<void> {
  const footer = dialog.getByRole('group', { name: 'Lifecycle' })
  const restart = footer.getByRole('button', { name: 'Restart session', exact: true })
  const fresh = footer.getByRole('button', { name: 'Fresh session', exact: true })
  const archive = footer.getByRole('button', { name: 'Archive', exact: true })
  await expect(restart).toHaveAccessibleDescription(/^Keeps the conversation/)
  await expect(fresh).toHaveAccessibleDescription(/^Forgets the conversation/)
  await expect(archive).toHaveAccessibleDescription(/^(Leaves the list|Stop the agent)/)
  const destructive = await fresh.evaluate((element) => {
    const probe = document.createElement('span')
    probe.className = 'text-destructive'
    element.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  })
  await expect(fresh).toHaveCSS('color', destructive)
  const [freshBox, archiveBox] = [await fresh.boundingBox(), await archive.boundingBox()]
  expect(archiveBox?.y ?? 0).toBeGreaterThan((freshBox?.y ?? 0) + (freshBox?.height ?? 0))
}
