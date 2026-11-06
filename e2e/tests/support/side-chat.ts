import { randomUUID } from 'node:crypto'
import { expect, type Page } from '@playwright/test'
import { openSeedDb } from './db.js'

/** Gives an agent a session id, which the fake Claude Code never reports, and returns it. */
export async function seedSession(taskId: string): Promise<string> {
  const session = randomUUID()
  const db = openSeedDb()
  await db.run('UPDATE task SET session_id = ? WHERE id = ?', session, taskId)
  await db.close()
  return session
}

export const sideChat = (page: Page) => page.getByRole('dialog', { name: 'Side chat' })

/** Fetches Seti's data again, as the palette's Reload data does, so the page sees a mod change. */
export async function reloadData(page: Page): Promise<void> {
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Search Seti' })
  await palette.getByRole('combobox').fill('>Reload data')
  await palette.getByRole('option', { name: /Reload data/ }).click()
  await expect(palette).toHaveCount(0)
}
