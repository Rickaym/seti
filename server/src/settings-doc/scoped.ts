import {
  AGENT_SETTINGS,
  scopedDocSchema,
  visibleKeys,
  WORKSPACE_SETTINGS,
  type AccessItem,
  type AnySettingsSection,
  type SettingsDoc,
  type SettingsDocReader,
  type SettingsSectionValue,
} from '@seti/shared'
import { z } from 'zod'
import { effectiveAccess } from '../agent-access.js'
import { taskCompactRules } from '../store/compact.js'
import { taskCpuCaps } from '../store/cpu.js'
import { dreamOptOuts } from '../store/dream-nights.js'
import { taskMemoryCaps } from '../store/memory.js'
import { permissionRules } from '../store/permissions.js'
import { requireTask } from '../tasks.js'
import { requireWorkspace } from '../workspaces.js'
import { settingsDocReader, withRevision } from './document.js'

type Rules = SettingsSectionValue<'security.permissions'>['rules']

/** Whether each item of some kinds is on for the agent, by kind and id. */
const choices = (items: readonly AccessItem[], kinds: readonly string[]) => {
  const byKind: Record<string, Record<string, boolean>> = {}
  for (const item of items.filter((entry) => kinds.includes(entry.kind))) {
    byKind[item.kind] = { ...byKind[item.kind], [item.id]: item.enabled }
  }
  return byKind
}

async function agentRules(taskId: string): Promise<Rules> {
  const own = (await permissionRules.list(taskId)).filter((rule) => rule.task_id === taskId)
  const of = (behavior: string) => own.filter((rule) => rule.behavior === behavior).map((rule) => rule.rule)
  return { allow: of('allow'), ask: of('ask'), deny: of('deny'), review: of('review') }
}

function visible(section: AnySettingsSection, value: Record<string, unknown>, reader: SettingsDocReader) {
  const keys = visibleKeys(section, reader) ?? []
  return Object.fromEntries(keys.map((key) => [key, value[key]]))
}

/** One agent's own settings for the caller; the EA's leaves its security settings out. */
export async function agentSettingsDoc(taskId: string): Promise<SettingsDoc> {
  const reader = settingsDocReader()
  const task = await requireTask(taskId)
  const access = await effectiveAccess(task)
  const value: z.output<typeof AGENT_SETTINGS.schema> = {
    title: task.title,
    color: task.color,
    pinned: task.pinned,
    workspace_id: task.workspace_id,
    notifications_muted: task.notifications_muted,
    input_mode: task.input_mode,
    runtime: task.runtime,
    requested_model: task.requested_model,
    requested_effort: task.requested_effort,
    dreams: !(await dreamOptOuts.get()).tasks.has(task.id),
    memory_cap: await taskMemoryCaps.get(task.id),
    cpu_cap: await taskCpuCaps.get(task.id),
    compaction: await taskCompactRules.get(task.id),
    access: choices(access.items, ['mcp', 'plugin', 'pack']),
    sandbox: task.sandbox,
    home_access: task.home_access,
    credential: access.profile.name,
    seti_control: task.seti_control,
    bypass_until: task.bypass_until,
    allowed_hosts: access.hosts,
    rules: await agentRules(task.id),
    security_access: choices(access.items, ['ssh', 'aws']),
  }
  return withRevision({ agent: visible(AGENT_SETTINGS, value, reader) })
}

/** One workspace's own settings. */
export async function workspaceSettingsDoc(id: string): Promise<SettingsDoc> {
  const reader = settingsDocReader()
  const workspace = await requireWorkspace(id)
  const value: z.output<typeof WORKSPACE_SETTINGS.schema> = {
    name: workspace.name,
    position: workspace.position,
    dreams: !(await dreamOptOuts.get()).workspaces.has(workspace.id),
  }
  return withRevision({ workspace: visible(WORKSPACE_SETTINGS, value, reader) })
}

/** The JSON Schema of an agent's or a workspace's document for the caller. */
export function scopedJsonSchema(key: 'agent' | 'workspace'): Record<string, unknown> {
  const schema = scopedDocSchema(key, settingsDocReader())
  return { ...z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }), title: `Seti ${key} settings` }
}
