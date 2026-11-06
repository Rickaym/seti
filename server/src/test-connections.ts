import { connectionCreateInput, envFor, type Connection, type ConnectionCreateInput } from '@seti/shared'
import { createConnection, setConnectionValue } from './connections.js'
import { sql } from './db.js'
import { connectionRows } from './store/connections.js'

/** A key connection holding `value`, made or refilled, for tests that need one by name. */
export async function keyConnection(
  name: string,
  value: string,
  extra: Partial<ConnectionCreateInput> = {},
): Promise<Connection> {
  const found = await connectionRows.byName(name)
  if (found !== undefined) {
    return setConnectionValue(found.id, 'value', value)
  }
  return createConnection(
    connectionCreateInput.parse({ name, kind: 'key', env: envFor(name), values: { value }, ...extra }),
  )
}

/** Deletes every connection and the values they held, so each test starts without any. */
export async function clearConnections(): Promise<void> {
  await sql`DELETE FROM connection`
  await sql`DELETE FROM secret WHERE starts_with(name, 'connection:') OR starts_with(name, 'named:')`
}
