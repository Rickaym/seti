import { vi } from 'vitest'
import { sql } from './db.js'

type Faked = NonNullable<NonNullable<Parameters<typeof vi.useFakeTimers>[0]>['toFake']>

/** Fakes timers once the pool is full, as postgres.js opens a connection through setTimeout. */
export async function fakeTimers(toFake: Faked): Promise<void> {
  await Promise.all(Array.from({ length: sql.options.max }, async () => sql`SELECT pg_sleep(0.05)`))
  vi.useFakeTimers({ toFake })
}
