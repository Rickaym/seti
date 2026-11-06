import { HOME_DAYS, HOME_MCP_LIMIT, type HomeMcpUse } from '@seti/shared'
import { homeStore, type McpCallRow } from './store/home.js'

const DAY_MS = 86_400_000
/** Message ids read per query, so the first scan of a month never holds one long query. */
const ID_BATCH = 20_000

/** Calls per server and UTC day, by task id. */
const counts = new Map<string, Map<string, Map<string, number>>>()
/** The last message id counted; null until the first scan. */
let cursor: number | null = null
let scanning: Promise<void> | null = null

const utcDay = (iso: string) => iso.slice(0, 10)

function add(row: McpCallRow): void {
  const servers = counts.get(row.task_id) ?? new Map<string, Map<string, number>>()
  const days = servers.get(row.server) ?? new Map<string, number>()
  const day = utcDay(row.created_at)
  days.set(day, (days.get(day) ?? 0) + 1)
  servers.set(row.server, days)
  counts.set(row.task_id, servers)
}

function prune(oldest: string): void {
  for (const [taskId, servers] of counts) {
    for (const [server, days] of servers) {
      for (const day of days.keys()) {
        if (day < oldest) {
          days.delete(day)
        }
      }
      if (days.size === 0) {
        servers.delete(server)
      }
    }
    if (servers.size === 0) {
      counts.delete(taskId)
    }
  }
}

/** Counts the calls stored since the last scan; the first scan starts a month back. */
async function scan(now: number): Promise<void> {
  const since = new Date(now - HOME_DAYS.month * DAY_MS).toISOString()
  const last = await homeStore.lastId()
  cursor ??= ((await homeStore.firstIdSince(since)) ?? last + 1) - 1
  while (cursor < last) {
    const upto = Math.min(last, cursor + ID_BATCH)
    for (const row of await homeStore.mcpCalls(cursor, upto)) {
      add(row)
    }
    cursor = upto
  }
  prune(utcDay(since))
}

const sum = (days: ReadonlyMap<string, number>) => [...days.values()].reduce((total, n) => total + n, 0)

/**
 * The MCP servers each agent's tool calls reached in the last 30 days, most called first. Each
 * read scans only the messages stored since the one before.
 */
export async function mcpUse(now = Date.now()): Promise<Map<string, HomeMcpUse[]>> {
  scanning ??= scan(now).finally(() => {
    scanning = null
  })
  await scanning
  return new Map(
    [...counts].map(([taskId, servers]) => [
      taskId,
      [...servers]
        .map(([server, days]) => ({ server, calls: sum(days) }))
        .sort((a, b) => (b.calls === a.calls ? a.server.localeCompare(b.server, 'en') : b.calls - a.calls))
        .slice(0, HOME_MCP_LIMIT),
    ]),
  )
}
