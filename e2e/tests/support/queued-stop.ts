import type { Page } from '@playwright/test'
import { HOLD_PROMPT } from './fake-claude.js'
import { expect } from './fixtures.js'
import { startAgent } from './many-prs.js'

export const QUEUED = 'Then tidy the docs'

const transcript = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Transcript' })
export const reply = (page: Page) => page.getByRole('combobox', { name: 'Reply' })
const ownRow = (page: Page, text: string) => page.locator('[data-own-message]').filter({ hasText: text })
const turnLines = (page: Page, outcome: string) => transcript(page).getByText(new RegExp(`^Turn ${outcome} \u00b7`))

/** An agent that answered its first prompt and now holds a turn until something stops it. */
export async function heldAgent(page: Page, label: string): Promise<string> {
  const { id } = await startAgent(page.request, label)
  await page.goto(`/#agents/${id}`)
  await expect(turnLines(page, 'done')).toHaveCount(1)
  const held = await page.request.post(`/api/tasks/${id}/messages`, { data: { prompt: HOLD_PROMPT } })
  expect(held.ok()).toBe(true)
  await expect(transcript(page)).toContainText('Working on it.')
  return id
}

/** Waits until the composer's message is stored and badged as queued behind the held turn. */
export async function expectQueued(page: Page): Promise<void> {
  await expect(ownRow(page, QUEUED)).toContainText('queued')
}

/** The queued message ran as the next turn, and the turn it cut short left no stop notice. */
export async function expectHandedOver(page: Page): Promise<void> {
  await expect(ownRow(page, QUEUED)).not.toContainText('queued')
  await expect(turnLines(page, 'done')).toHaveCount(2)
  await expect(turnLines(page, 'interrupted')).toHaveCount(0)
  await expect(turnLines(page, 'failed')).toHaveCount(0)
  await expect(transcript(page).getByText('agent stopped: interrupted by a new message')).toHaveCount(0)
  await expect(transcript(page).getByText('[Request interrupted by user]')).toHaveCount(0)
  await expect(page.getByRole('main').getByRole('region', { name: 'Turn failed' })).toHaveCount(0)
}

/** A stop with nothing queued still says the turn was interrupted. */
export async function expectStopped(page: Page): Promise<void> {
  await expect(turnLines(page, 'interrupted')).toHaveCount(1)
  await expect(turnLines(page, 'done')).toHaveCount(1)
  await expect(transcript(page).getByText('[Request interrupted by user]')).toHaveCount(0)
}
