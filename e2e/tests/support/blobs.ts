import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { expect } from './fixtures.js'
import { modToggle } from './mods.js'

export interface BlobAgent {
  id: string
  title: string
  /** The marker's accessible name, which the blob must keep. */
  label: string
  expression: string
  /** It has a colour, so its row shows a bar while the mod is off. */
  colored: boolean
}

/** One agent per status the list can show without GitHub, most in a preset colour. */
const STATES = [
  {
    title: 'Fixing the login flow',
    label: 'running',
    expression: 'happy',
    color: '#5488ec',
    set: "status = 'running'",
  },
  { title: 'Which branch to push', label: 'asks you', expression: 'asking', color: '#e4a339', set: 'asking = true' },
  {
    title: 'Wants to run a script',
    label: 'waits on you',
    expression: 'alert',
    color: '#b066da',
    set: "blocked = 'Allow Bash'",
  },
  { title: 'Build broke on CI', label: 'error', expression: 'error', color: '#e8605b', set: "status = 'error'" },
  {
    title: 'Cut off by a restart',
    label: 'interrupted',
    expression: 'neutral',
    color: '#3baca6',
    set: "status = 'interrupted'",
  },
  { title: 'Docs pass done', label: 'idle', expression: 'asleep', color: '#4eb068', set: null },
  { title: 'Paused refactor', label: 'stopped', expression: 'neutral', color: null, set: "status = 'stopped'" },
] as const

const pick = ({ title, label, expression }: (typeof STATES)[number]) => ({ title, label, expression })

/** Seeds one agent in each state and returns them in the order the list may show them. */
export async function seedBlobAgents(): Promise<BlobAgent[]> {
  const db = openSeedDb()
  const agents: BlobAgent[] = []
  for (const [i, state] of STATES.entries()) {
    const id = randomUUID()
    await db.idleTask(id, state.title, paths.root, new Date(Date.now() - i * 60_000).toISOString())
    await db.run('UPDATE task SET color = ? WHERE id = ?', state.color, id)
    if (state.set !== null) {
      await db.run(`UPDATE task SET ${state.set} WHERE id = ?`, id)
    }
    agents.push({ ...pick(state), id, colored: state.color !== null })
  }
  await db.close()
  return agents
}

/** An agent's row in the list. */
const rowOf = (page: Page, agent: BlobAgent): Locator =>
  page.locator(`[data-task-id="${agent.id}"]`).getByRole('button')

/** An agent's status marker in the list, by its row. */
const markerOf = (page: Page, agent: BlobAgent): Locator =>
  rowOf(page, agent).getByRole('img', { name: agent.label, exact: true })

/** The bookmark blob on an agent's row, which stands in for its colour bar. */
export const bookmarkOf = (page: Page, agent: BlobAgent): Locator => rowOf(page, agent).getByTestId('blob-bookmark')

/**
 * Checks every seeded row. Off: Seti's bar and status shape. On: a bookmark blob with the
 * status's face and the marker's tooltip, no bar, and the marker hidden but kept for readers.
 */
export async function expectMarkers(page: Page, agents: readonly BlobAgent[], blobs: boolean): Promise<void> {
  for (const agent of agents) {
    const marker = markerOf(page, agent)
    const bookmark = bookmarkOf(page, agent)
    await expect(marker, agent.label).toHaveCount(1)
    await expect(marker).toHaveAttribute('title', agent.label)
    if (blobs) {
      await expect(bookmark).toHaveAttribute('data-expression', agent.expression)
      await expect(bookmark).toBeVisible()
      await expect(rowOf(page, agent).locator('[data-agent-accent]')).toHaveAttribute('title', agent.label)
      expect((await marker.boundingBox())?.width ?? 0, agent.label).toBeLessThanOrEqual(1)
      expect(await marker.evaluate((node) => [...node.children].every((child) => !child.checkVisibility()))).toBe(true)
      await expect(rowOf(page, agent)).toHaveCSS('background-image', 'none')
    } else {
      await expect(bookmark).toHaveCount(0)
      await expect(marker).toBeVisible()
      await expect(marker.locator('svg')).toHaveCount(1)
      expect((await marker.boundingBox())?.width ?? 0, agent.label).toBeGreaterThan(1)
      await expect(rowOf(page, agent)).toHaveCSS('background-image', agent.colored ? /linear-gradient/ : 'none')
    }
  }
}

/** Each seeded row's height and what screen readers get from it, ages aside, to compare. */
export async function rowsOf(page: Page, agents: readonly BlobAgent[]): Promise<string[]> {
  return Promise.all(
    agents.map(async (agent) => {
      const row = rowOf(page, agent)
      const tree = (await row.ariaSnapshot()).replace(/\b\d+[smhdw]\b/g, 'age')
      return `${String((await row.boundingBox())?.height ?? 0)} ${tree}`
    }),
  )
}

/** How many animations run on an element, its children included. */
export const animationsOf = async (element: Locator): Promise<number> =>
  element.evaluate((node) => node.getAnimations({ subtree: true }).length)

/** Flips the Blobs switch on Settings, Mods and returns to the agent list, without a reload. */
export async function switchBlobs(page: Page, on: boolean): Promise<void> {
  await page.goto('/#settings/mods')
  const toggle = modToggle(page, 'Blobs')
  await toggle.scrollIntoViewIfNeeded()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', String(on))
  await page.goto('/#agents')
}

/** Marks the loaded page, so a test can tell it was never reloaded. */
export async function markPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset.blobsProbe = 'loaded'
  })
}

export const samePage = async (page: Page) =>
  page.evaluate(() => document.documentElement.dataset.blobsProbe === 'loaded')

/** The blob mod's settings as Settings, Mods saves them. */
const BLOB_DEFAULTS = {
  size: 'Medium',
  animation: true,
  list: true,
  'needs-you': true,
  grid: true,
} as const

type BlobSettings = {
  -readonly [K in keyof typeof BLOB_DEFAULTS]?: (typeof BLOB_DEFAULTS)[K] extends boolean ? boolean : string
}

/** Saves blob settings through the API, as Settings, Mods does; the page reads them on load. */
export async function setBlobSettings(request: APIRequestContext, settings: BlobSettings): Promise<void> {
  const response = await request.patch('/api/mods/blobs', { data: { settings } })
  expect(response.status(), await response.text()).toBe(200)
}

/** Turns the mod off and puts its settings back, so the next test starts clean. */
export async function resetBlobs(request: APIRequestContext): Promise<void> {
  const response = await request.patch('/api/mods/blobs', { data: { enabled: false, settings: BLOB_DEFAULTS } })
  expect(response.status(), await response.text()).toBe(200)
}

/** The bookmark side each size draws at, with a mouse and on a touch screen; look.ts matches it. */
export const SIZE_PX = {
  Small: { fine: 20, coarse: 24 },
  Medium: { fine: 28, coarse: 32 },
  Large: { fine: 34, coarse: 40 },
} as const

/**
 * Checks every seeded bookmark sits whole inside its row and the screen, at least 4 px in from
 * the row's left edge, at the side its size asks for.
 */
export async function expectInsideRows(page: Page, agents: readonly BlobAgent[], side: number): Promise<void> {
  const width = page.viewportSize()?.width ?? 0
  for (const agent of agents) {
    const row = await rowOf(page, agent).boundingBox()
    const blob = await bookmarkOf(page, agent).boundingBox()
    if (row === null || blob === null) {
      throw new Error(`no row or bookmark for ${agent.label}`)
    }
    expect(Math.round(blob.height), agent.label).toBe(side)
    expect(blob.x, agent.label).toBeGreaterThanOrEqual(Math.max(0, row.x) + 4)
    expect(blob.x + blob.width, agent.label).toBeLessThanOrEqual(Math.min(width, row.x + row.width))
    expect(blob.y, agent.label).toBeGreaterThanOrEqual(row.y)
    expect(blob.y + blob.height, agent.label).toBeLessThanOrEqual(row.y + row.height)
  }
}

/** Where each seeded row's title starts, so rows with and without a blob can be compared. */
export async function titleStarts(page: Page, agents: readonly BlobAgent[]): Promise<number[]> {
  return Promise.all(
    agents.map(
      async (agent) => (await rowOf(page, agent).getByText(agent.title, { exact: true }).boundingBox())?.x ?? -1,
    ),
  )
}

/** Picks a blob setting on the mod's settings page, then returns to the list without a reload. */
export async function pickBlobSetting(page: Page, name: 'Size', value: string): Promise<void> {
  await page.goto('/#settings/mods/blobs/settings')
  const select = page.getByRole('combobox', { name, exact: true })
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/mods/blobs') && r.request().method() === 'PATCH')
  await select.selectOption(value)
  await saved
  await page.goto('/#agents')
}

/** Flips a blob toggle on the mod's settings page, then returns to the list without a reload. */
export async function flipBlobSetting(page: Page, name: string, on: boolean): Promise<void> {
  await page.goto('/#settings/mods/blobs/settings')
  const toggle = page.getByRole('main').getByRole('button', { name, exact: true })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', String(on))
  await page.goto('/#agents')
}
