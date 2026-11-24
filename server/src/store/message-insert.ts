import type { MessageBody } from '@seti/shared'
import { messageColumns } from '../events/columns.js'
import type { Db } from '../pg.js'
import { scrubValue } from '../scrub.js'
import { storedJson } from '../stored-rows.js'
import { indexRuntimeRows } from './search-runtime.js'

export interface NewMessage {
  taskId: string
  body: MessageBody
  outward: string[]
  createdAt: string
}

/** Stores a message with its credentials redacted, so the database never holds them. */
export async function insertMessage(db: Db, { taskId, body, outward, createdAt }: NewMessage): Promise<number> {
  const payload = storedJson(scrubValue(body.payload))
  const row = { task_id: taskId, kind: body.kind, payload, outward: JSON.stringify(outward), created_at: createdAt }
  const columns = messageColumns(body)
  const [stored] = await db<{ id: number }[]>`INSERT INTO task_message ${db({ ...row, ...columns })} RETURNING id`
  if (stored === undefined) {
    throw new Error('Message was not recorded')
  }
  await indexRuntimeRows(db, [{ ...row, id: stored.id, runtime: columns.runtime }])
  return stored.id
}
