import type { ModCommand } from '@seti/shared'
import { modWords } from './mod-text.js'
import { modCommands, type ModCommandEntry } from './points.js'

function argText(name: string, arg: ModCommand['args'][string]): string {
  const kind = arg.optional ? `${arg.type}, optional` : arg.type
  return arg.description === undefined ? `${name} (${kind})` : `${name} (${kind}): ${arg.description}`
}

const argLine = (command: ModCommand) => {
  const args = Object.entries(command.args).map(([name, arg]) => argText(name, arg))
  return args.length === 0 ? 'No args.' : `Args: ${args.join('; ')}.`
}

/** One action as the EA reads it in its prompt. */
const actionLine = ({ mod, modName, command }: ModCommandEntry): string =>
  [
    `- ${mod} ${command.id} (${modName}): ${modWords(command.title)}.`,
    command.description === undefined ? '' : `The mod describes it as ${modWords(command.description)}.`,
    argLine(command),
    command.changes ? 'Changes something, so it needs the yes.' : '',
  ]
    .filter((part) => part !== '')
    .join(' ')

/** The actions the EA may run now, as its prompt lists them; empty when no mod offers one. */
export function eaModActions(): string {
  const lines = modCommands
    .list()
    .filter((entry) => entry.command.for.includes('ea'))
    .map(actionLine)
  if (lines.length === 0) {
    return ''
  }
  return [
    '## Mod actions',
    "The mods that are on offer these actions. Run one with run_mod_action, giving the mod's id, the action and its args; give task as the agent's title or id. One that changes something needs the user's yes, as your own tools do.",
    ...lines,
  ].join('\n')
}
