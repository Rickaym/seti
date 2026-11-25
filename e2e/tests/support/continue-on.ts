import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

/** Seeds an idle agent recorded as a Codex agent that never ran a session. */
export async function seedIdleCodexAgent(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  try {
    await db.idleTask(id, title, paths.checkout, new Date().toISOString())
    await db.run(`UPDATE task SET runtime = 'codex', requested_model = 'gpt-5.5' WHERE id = ?`, id)
  } finally {
    await db.close()
  }
  return id
}

/** The agent settings' runtime picker, which moves the agent once a runtime is chosen. */
export const continueOnPicker = (page: Page) => page.getByRole('combobox', { name: 'Continue on' })
