import { randomUUID } from 'node:crypto'
import { HANDOVER_TAG, handoverPreface } from '@seti/shared'
import { openSeedDb } from './db.js'
import { paths } from './env.js'

/** Ids of a lead, a helper it started, and an agent between them in the server's order. */
export interface SeededDelegates {
  lead: string
  helper: string
  other: string
}

/** A line of the brief the helper got, which the fold shows once opened. */
export const BRIEF_LINE = 'Done: moved the ledger writes behind one transaction in payments/ledger.ts'

const firstMessage = (lead: string, leadId: string) =>
  [
    'Write the migration tests for the ledger change.',
    '',
    handoverPreface(lead),
    `<${HANDOVER_TAG} from="${lead}" runtime="claude" task_id="${leadId}">`,
    `# ${lead}\nAsked: Refactor the payments ledger.\n${BRIEF_LINE}`,
    `</${HANDOVER_TAG}>`,
  ].join('\n')

/** Three idle agents; the helper is the newest and the lead the oldest, so nesting moves it. */
export async function seedDelegates(lead: string, helper: string, other: string): Promise<SeededDelegates> {
  const db = openSeedDb()
  const ids = { lead: randomUUID(), helper: randomUUID(), other: randomUUID() }
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
  try {
    await db.idleTask(ids.lead, lead, paths.checkout, at(3))
    await db.idleTask(ids.other, other, paths.checkout, at(2))
    await db.idleTask(ids.helper, helper, paths.checkout, at(1))
    await db.run('UPDATE task SET delegated_by = ?, runtime = ? WHERE id = ?', ids.lead, 'codex', ids.helper)
    const prompt = { text: firstMessage(lead, ids.lead), from: lead }
    await db.message(ids.helper, 'prompt', JSON.stringify(prompt), at(1))
  } finally {
    await db.close()
  }
  return ids
}
