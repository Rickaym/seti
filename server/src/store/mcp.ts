import type { McpChoices } from '@seti/shared'
import { now, sql, transaction, type Db } from '../db.js'

interface ChoiceRow {
  name: string
  enabled: boolean
}

const toChoices = (rows: readonly ChoiceRow[]): McpChoices =>
  Object.fromEntries(rows.map((row) => [row.name, row.enabled]))

/** Defaults set in Settings; a server without a row follows `fallback`, on unless borrowed. */
export const mcpDefaults = {
  all: async (): Promise<McpChoices> =>
    toChoices(await sql<ChoiceRow[]>`SELECT name, enabled FROM mcp_server_default ORDER BY name`),
  set: async (name: string, enabled: boolean, fallback = true): Promise<void> => {
    if (enabled === fallback) {
      await sql`DELETE FROM mcp_server_default WHERE name = ${name}`
      return
    }
    await sql`INSERT INTO mcp_server_default (name, enabled, updated_at) VALUES (${name}, ${enabled}, ${now()})
      ON CONFLICT (name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
  },
}

async function replaceTaskChoices(db: Db, taskId: string, choices: McpChoices): Promise<void> {
  await db`DELETE FROM task_mcp_server WHERE task_id = ${taskId}`
  for (const [name, enabled] of Object.entries(choices)) {
    await db`INSERT INTO task_mcp_server (task_id, name, enabled) VALUES (${taskId}, ${name}, ${enabled})`
  }
}

/** The MCP servers a task turned on or off against the defaults. */
export const taskMcpChoices = {
  get: async (taskId: string): Promise<McpChoices> =>
    toChoices(
      await sql<ChoiceRow[]>`SELECT name, enabled FROM task_mcp_server WHERE task_id = ${taskId} ORDER BY name`,
    ),
  set: async (taskId: string, choices: McpChoices): Promise<void> => {
    await transaction(async (tx) => {
      await replaceTaskChoices(tx, taskId, choices)
    })
  },
}

/** Every server name a default or task choice is stored for. */
export async function storedMcpNames(): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`SELECT name FROM mcp_server_default
    UNION SELECT name FROM task_mcp_server ORDER BY name`
  return rows.map((row) => row.name)
}

/** Drops every default and choice stored for these servers, so one added again starts afresh. */
export async function forgetMcpChoices(names: readonly string[]): Promise<void> {
  const list = [...names]
  await transaction(async (tx) => {
    await tx`DELETE FROM mcp_server_default WHERE name = ANY(${list}::text[])`
    await tx`DELETE FROM task_mcp_server WHERE name = ANY(${list}::text[])`
  })
}

/** Registered repos, whose checkouts must exist, and the directories agents run in. */
export async function mcpConfigDirs(): Promise<{ repos: string[]; agents: string[] }> {
  const repos = await sql<{ path: string }[]>`SELECT path FROM repo ORDER BY path`
  const agents = await sql<{ cwd: string }[]>`SELECT DISTINCT cwd FROM task WHERE archived_at IS NULL ORDER BY cwd`
  return { repos: repos.map((row) => row.path), agents: agents.map((row) => row.cwd) }
}
