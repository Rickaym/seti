import { scheduleIssue, type DreamSettings, type DreamSettingsInput, type Task } from '@seti/shared'
import { audit } from '../audit.js'
import { refuseAgent, refuseAtSelf, refuseOnSelf } from '../ea-guard.js'
import { HttpError } from '../http.js'
import { dreamOptOuts, dreamSettings } from '../store/dream-nights.js'
import { workspaceRows } from '../store/workspaces.js'

/** Whether nightly Dreaming covers the agent: on, and neither it nor its workspace switched out. */
export async function dreamsOn(task: Pick<Task, 'id' | 'workspace_id'>): Promise<boolean> {
  if (!(await dreamSettings.get()).enabled) {
    return false
  }
  const off = await dreamOptOuts.get()
  return !off.tasks.has(task.id) && !off.workspaces.has(task.workspace_id)
}

/** The settings after a change, refused with 400 when the result does not hold together. */
function merged(current: DreamSettings, input: DreamSettingsInput): DreamSettings {
  const given = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
  const next: DreamSettings = { ...current, ...given }
  if (next.enabled && next.zone === null) {
    throw new HttpError(400, 'Choose the zone the window is in before turning Dreaming on')
  }
  if (next.zone !== null && scheduleIssue('0 1 * * *', next.zone) !== null) {
    throw new HttpError(400, `Unknown zone "${next.zone}"; use an IANA name such as Europe/Istanbul`)
  }
  if (next.window_start === next.window_end) {
    throw new HttpError(400, 'The window needs different start and end times')
  }
  if (next.dream_budget_usd > next.night_budget_usd) {
    throw new HttpError(400, "A dream's budget cannot be more than the night's")
  }
  return next
}

/**
 * Changes Dreaming's settings as the user, or as the EA after the user's yes, audited with what
 * changed. Agents and mods are refused: the settings hold the caps every dream runs under.
 */
export async function updateDreamSettings(input: DreamSettingsInput): Promise<DreamSettings> {
  refuseAgent('change Dreaming settings')
  const current = await dreamSettings.get()
  const next = merged(current, input)
  const changed = (Object.keys(input) as (keyof DreamSettings)[]).filter((key) => current[key] !== next[key])
  if (changed.length === 0) {
    return current
  }
  await dreamSettings.set(next)
  const turned = `Turned Dreaming ${next.enabled ? 'on' : 'off'}`
  await audit.record({
    actor: 'user',
    kind: 'dream.settings_changed',
    subject_type: 'system',
    summary: changed.includes('enabled') ? turned : `Changed Dreaming: ${changed.join(', ')}`,
    detail: {
      changed,
      ...Object.fromEntries(
        changed.flatMap((key) => [
          [key, next[key]],
          [`${key}_was`, current[key]],
        ]),
      ),
    },
  })
  return next
}

/**
 * Switches one agent in or out of Dreaming. Below Seti control Full an agent cannot, and no agent
 * switches itself, so text that persuaded it cannot take it out of the pass that would catch it.
 */
export async function setTaskDreaming(task: Task, on: boolean): Promise<void> {
  refuseAtSelf("change an agent's Dreaming")
  refuseOnSelf(task.id, 'switch Dreaming for')
  await dreamOptOuts.setTask(task.id, on)
  await audit.record({
    actor: 'user',
    kind: 'dream.opt_changed',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Switched Dreaming ${on ? 'on' : 'off'} for ${task.title}`,
    detail: { on },
  })
}

/** Switches a workspace's agents in or out of Dreaming together. */
export async function setWorkspaceDreaming(workspaceId: string, on: boolean): Promise<void> {
  refuseAtSelf("change a workspace's Dreaming")
  const workspace = await workspaceRows.get(workspaceId)
  if (workspace === undefined) {
    throw new HttpError(404, 'No such workspace')
  }
  await dreamOptOuts.setWorkspace(workspace.id, on)
  await audit.record({
    actor: 'user',
    kind: 'dream.opt_changed',
    subject_type: 'workspace',
    subject_id: workspace.id,
    summary: `Switched Dreaming ${on ? 'on' : 'off'} for the ${workspace.name} workspace`,
    detail: { on },
  })
}
