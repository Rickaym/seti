import type { SettingNote } from '@seti/shared'
import { appendMessage } from './runner.js'
import { inLane } from './task-lane.js'

/**
 * Leaves a line in the agent's transcript for a change to what it may reach, from its settings,
 * a command or the EA alike, as Bypass and Seti control do.
 */
export async function noteSetting(taskId: string, setting: SettingNote, text: string): Promise<void> {
  await inLane(taskId, async () => appendMessage(taskId, { kind: 'seti', payload: { error: text, setting } }))
}
