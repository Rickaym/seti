import { MOD_TASK_ARG, modCommandArgShape, modToolName, type SetiControlLevel } from '@seti/shared'
import { z } from 'zod'
import type { SetiTool } from './tool.js'
import { runModAction } from '../mods/commands.js'
import { modOutput, modWords } from '../mods/mod-text.js'
import { modCommands, type ModCommandEntry } from '../mods/points.js'

const argsOf = (args: unknown): Record<string, unknown> =>
  typeof args === 'object' && args !== null ? { ...(args as Record<string, unknown>) } : {}

const describe = ({ modName, command }: ModCommandEntry, self: boolean) =>
  [
    `A command of the ${modName} mod, titled ${modWords(command.title)}.`,
    command.description === undefined ? '' : `The mod describes it as ${modWords(command.description)}.`,
    self ? 'At Seti control Self it acts on you.' : '',
  ]
    .filter((part) => part !== '')
    .join(' ')

/** The agent tool of one command; at Self its task argument is left out and is the caller. */
function toolOf(entry: ModCommandEntry, self: boolean): SetiTool {
  const shape = modCommandArgShape(entry.command)
  const input = self ? Object.fromEntries(Object.entries(shape).filter(([name]) => name !== MOD_TASK_ARG)) : shape
  const schema = z.strictObject(input)
  return {
    name: modToolName(entry.mod, entry.command.id),
    description: describe(entry, self),
    input,
    call: async (args, ctx) => {
      const checked: Record<string, unknown> = { ...schema.parse(argsOf(args ?? {})) }
      const sent = self ? { ...checked, [MOD_TASK_ARG]: ctx.caller.id } : checked
      const answer = await runModAction(entry.mod, entry.command.id, sent)
      const { result, text } = answer
      return modOutput(entry.mod, typeof result === 'object' && result !== null ? JSON.stringify(result) : text)
    },
  }
}

/**
 * The tools of the commands enabled mods offer agents: every one at Full, and at Self only those
 * that act on one agent, which is then the caller.
 */
export function modActionTools(level: SetiControlLevel): SetiTool[] {
  if (level === 'off') {
    return []
  }
  return modCommands
    .list()
    .filter((entry) => entry.command.for.includes('agents') && (level === 'full' || entry.command.level === 'self'))
    .map((entry) => toolOf(entry, level === 'self'))
}
