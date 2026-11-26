import { SOURCE_KINDS, type SourceKind } from '@seti/shared'
import { rowFilter, sql } from '../db.js'
import type { FoundItem } from '../sources/item.js'

/** A ledger row: where the item came from and the transcript row and call whose result holds it. */
export interface SourceItem {
  id: number
  task_id: string
  message_id: number
  call_id: string
  kind: SourceKind
  container: string
  ref: string
  permalink: string
  at: string | null
  spans: string[]
}

interface Row {
  id: string
  task_id: string
  message_id: string
  call_id: string
  kind: string
  container: string
  ref: string
  permalink: string
  item_at: string | null
  spans: string
}

const kindOf = (kind: string): SourceKind => SOURCE_KINDS.find((known) => known === kind) ?? 'file'

const toItem = (row: Row): SourceItem => ({
  id: Number(row.id),
  task_id: row.task_id,
  message_id: Number(row.message_id),
  call_id: row.call_id,
  kind: kindOf(row.kind),
  container: row.container,
  ref: row.ref,
  permalink: row.permalink,
  at: row.item_at,
  spans: JSON.parse(row.spans) as string[],
})

/** Most rows one lookup of a key returns, newest first: the same item read again adds a row. */
const PER_REF = 5

/** Escapes `%`, `_` and the escape itself for a LIKE prefix. */
function likePrefix(text: string): string {
  const escaped = text.replace(/[\\%_]/g, (ch) => `\\${ch}`)
  return `${escaped}%`
}

export const sourceItems = {
  add: async (taskId: string, messageId: number, callId: string, items: readonly FoundItem[]): Promise<void> => {
    if (items.length === 0) {
      return
    }
    const rows = items.map((item) => ({
      task_id: taskId,
      message_id: messageId,
      call_id: callId,
      kind: item.kind,
      container: item.container,
      ref: item.ref,
      permalink: item.permalink,
      item_at: item.at,
      spans: JSON.stringify(item.spans),
    }))
    await sql`INSERT INTO source_item ${sql(rows)}`
  },
  /** The agent's items under a key, or under keys it starts, newest first. */
  find: async (taskId: string, ref: string, prefix = false): Promise<SourceItem[]> => {
    const rows = prefix
      ? await sql<Row[]>`SELECT * FROM source_item WHERE task_id = ${taskId} AND ref LIKE ${likePrefix(ref)}
          ORDER BY id DESC LIMIT ${PER_REF}`
      : await sql<Row[]>`SELECT * FROM source_item WHERE task_id = ${taskId} AND ref = ${ref}
          ORDER BY id DESC LIMIT ${PER_REF}`
    return rows.map(toItem)
  },
  /** The workspace host of the newest Slack permalink in the agent's ledger. */
  slackHost: async (taskId: string): Promise<string | null> => {
    const [row] = await sql<{ permalink: string }[]>`SELECT permalink FROM source_item
      WHERE task_id = ${taskId} AND kind = 'slack' AND permalink <> '' ORDER BY id DESC LIMIT 1`
    return row === undefined ? null : new URL(row.permalink).hostname
  },
  /** Every item of the agent, oldest first. */
  forTask: async (taskId: string): Promise<SourceItem[]> =>
    (await sql<Row[]>`SELECT * FROM source_item WHERE task_id = ${taskId} ORDER BY id`).map(toItem),
  /** Forgets the agent's items before they are read again from its transcript. */
  clear: async (taskId: string): Promise<void> => {
    await sql`DELETE FROM source_item WHERE task_id = ${taskId}`
  },
}

export const transcriptText = {
  /** Whether the agent's transcript holds rows; an archived agent's does not. */
  present: async (taskId: string): Promise<boolean> => {
    const [row] = await sql<{ id: string }[]>`SELECT id FROM task_message WHERE task_id = ${taskId} LIMIT 1`
    return row !== undefined
  },
  /**
   * Whether a row the agent did not write holds one of these texts, compared in lower case: a tool
   * result, a prompt or an update, never its own replies, calls or turn ends.
   */
  mentions: async (taskId: string, needles: readonly string[]): Promise<boolean> => {
    if (needles.length === 0) {
      return false
    }
    const lowered = needles.map((needle) => needle.toLowerCase())
    const read = sql`(kind <> 'sdk' OR ${rowFilter.resultRow} OR NOT (${rowFilter.agentRow} OR ${rowFilter.turnEnd}))`
    const [row] = await sql<{ id: string }[]>`SELECT id FROM task_message WHERE task_id = ${taskId} AND ${read}
      AND EXISTS (SELECT 1 FROM unnest(${lowered}::text[]) AS needle WHERE strpos(lower(payload), needle) > 0)
      LIMIT 1`
    return row !== undefined
  },
}
