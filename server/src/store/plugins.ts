import { randomUUID } from 'node:crypto'
import type { SetiPlugin } from '@seti/shared'
import { now, sql, transaction } from '../db.js'
import { HttpError } from '../http.js'

type PluginRecord = Omit<SetiPlugin, 'enabled'> & { enabled: number }
type PluginFields = Pick<SetiPlugin, 'name' | 'path' | 'version' | 'description'>

const toPlugin = (r: PluginRecord): SetiPlugin => ({ ...r, enabled: r.enabled === 1 })

export const setiPlugins = {
  list: async () => (await sql<PluginRecord[]>`SELECT * FROM seti_plugin ORDER BY lower(name), path`).map(toPlugin),
  get: async (id: string) => {
    const [record] = await sql<PluginRecord[]>`SELECT * FROM seti_plugin WHERE id = ${id}`
    return record && toPlugin(record)
  },
  create: async (fields: PluginFields): Promise<SetiPlugin> => {
    if ((await sql`SELECT id FROM seti_plugin WHERE path = ${fields.path}`).length > 0) {
      throw new HttpError(409, `${fields.path} is already a Seti default plugin`)
    }
    if ((await sql`SELECT id FROM seti_plugin WHERE name = ${fields.name}`).length > 0) {
      throw new HttpError(409, `A Seti default plugin named "${fields.name}" already exists`)
    }
    const plugin: SetiPlugin = { ...fields, id: randomUUID(), enabled: true, created_at: now() }
    await sql`INSERT INTO seti_plugin (id, name, path, version, description, enabled, created_at)
      VALUES (${plugin.id}, ${plugin.name}, ${plugin.path}, ${plugin.version}, ${plugin.description}, 1,
        ${plugin.created_at})`
    return plugin
  },
  setEnabled: async (id: string, enabled: boolean) =>
    (await sql`UPDATE seti_plugin SET enabled = ${enabled ? 1 : 0} WHERE id = ${id}`).count > 0,
  remove: async (id: string) => (await sql`DELETE FROM seti_plugin WHERE id = ${id}`).count > 0,
  assertExist: async (ids: readonly string[]): Promise<void> => {
    const found = new Set(
      (await sql<{ id: string }[]>`SELECT id FROM seti_plugin WHERE id = ANY(${[...ids]})`).map((row) => row.id),
    )
    const missing = ids.find((id) => !found.has(id))
    if (missing !== undefined) {
      throw new HttpError(400, `Unknown Seti plugin ${missing}`)
    }
  },
}

/** A task's plugin overrides: opt-outs of plugins on by default, opt-ins of ones off by default. */
export const taskPluginChoices = {
  get: async (taskId: string): Promise<Record<string, boolean>> =>
    Object.fromEntries(
      (
        await sql<{ plugin_id: string; enabled: boolean }[]>`
          SELECT plugin_id, false AS enabled FROM task_plugin_optout WHERE task_id = ${taskId}
          UNION ALL SELECT plugin_id, true AS enabled FROM task_plugin_optin WHERE task_id = ${taskId}
          ORDER BY plugin_id`
      ).map((row) => [row.plugin_id, row.enabled]),
    ),
  /** Opts the task out of these plugins, and drops its other overrides. */
  setOptOuts: async (taskId: string, pluginIds: readonly string[]): Promise<void> => {
    await transaction(async (tx) => {
      await tx`DELETE FROM task_plugin_optout WHERE task_id = ${taskId}`
      await tx`DELETE FROM task_plugin_optin WHERE task_id = ${taskId}`
      for (const pluginId of pluginIds) {
        await tx`INSERT INTO task_plugin_optout (task_id, plugin_id) VALUES (${taskId}, ${pluginId})
          ON CONFLICT DO NOTHING`
      }
    })
  },
  setOne: async (taskId: string, pluginId: string, enabled: boolean | null): Promise<void> => {
    await transaction(async (tx) => {
      await tx`DELETE FROM task_plugin_optout WHERE task_id = ${taskId} AND plugin_id = ${pluginId}`
      await tx`DELETE FROM task_plugin_optin WHERE task_id = ${taskId} AND plugin_id = ${pluginId}`
      if (enabled === true) {
        await tx`INSERT INTO task_plugin_optin (task_id, plugin_id) VALUES (${taskId}, ${pluginId})`
      } else if (enabled === false) {
        await tx`INSERT INTO task_plugin_optout (task_id, plugin_id) VALUES (${taskId}, ${pluginId})`
      }
    })
  },
}
