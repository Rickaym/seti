import { archivedRefusal, type Task } from '@seti/shared'
import { z } from 'zod'
import { tasks } from '../db.js'
import { outsideSelf, ownTaskOnly } from '../ea-guard.js'
import { ToolRefusal } from './tool.js'

const ID_PREFIX = /^[0-9a-f-]{4,}$/

const words = (text: string) => text.toLowerCase().trim().replace(/\s+/g, ' ')

/**
 * The one item a reference names: its id, a unique id prefix, its name, or a unique part of its
 * name. Several or no matches are refused with the candidates, so the agent can ask again.
 */
export function pickOne<T>(items: readonly T[], ref: string, noun: string, key: (item: T) => [string, string]): T {
  const wanted = ref.trim()
  const low = words(wanted)
  const rules: ((item: T) => boolean)[] = [
    (item) => key(item)[0] === wanted,
    (item) => ID_PREFIX.test(low) && key(item)[0].toLowerCase().startsWith(low),
    (item) => words(key(item)[1]) === low,
    (item) => low !== '' && words(key(item)[1]).includes(low),
  ]
  for (const rule of rules) {
    const found = items.filter(rule)
    if (found.length === 1 && found[0] !== undefined) {
      return found[0]
    }
    if (found.length > 1) {
      const shown = found.slice(0, 8).map((item) => `${key(item)[1]} (${key(item)[0]})`)
      throw new ToolRefusal(`"${ref}" matches ${String(found.length)} ${noun}s: ${shown.join('; ')}. Pass the id.`)
    }
  }
  throw new ToolRefusal(`No ${noun} matches "${ref}".`)
}

export const taskRef = z
  .string()
  .trim()
  .min(1)
  .describe("The agent's id, a unique id prefix, or its title; a unique part of the title works too.")

const taskKey = (task: Task): [string, string] => [task.id, task.title]

/**
 * The agent a reference names. At Seti control Self only the caller can match, so a reference to
 * another agent is refused without saying which agents exist.
 */
async function resolveTask(ref: string): Promise<Task> {
  const all = await tasks.listAll()
  const own = ownTaskOnly()
  if (own === null) {
    return pickOne(all, ref, 'agent', taskKey)
  }
  const mine = all.filter((task) => task.id === own)
  try {
    return pickOne(mine, ref, 'agent', taskKey)
  } catch {
    throw outsideSelf()
  }
}

/** An agent that is not archived, for anything that changes it or sends it work. */
export async function liveTask(ref: string): Promise<Task> {
  const task = await resolveTask(ref)
  if (task.archived_at !== null) {
    throw new ToolRefusal(archivedRefusal(task.title))
  }
  return task
}

/** Any agent, archived or not, for reading it, restoring it or deleting it. */
export async function anyTask(ref: string): Promise<Task> {
  return resolveTask(ref)
}
