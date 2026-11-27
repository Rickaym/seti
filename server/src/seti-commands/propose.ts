import { OWN_TOOLS, parseSetiLine, type RequestedChange, type SetiCommand, type Task } from '@seti/shared'
import { HttpError } from '../http.js'
import { runSetiCommand } from './run.js'
import { commandWorld } from './world.js'

/** Why an agent may not propose the command: it has its own tool for it, or it is the user's. */
function proposalRefusal(command: SetiCommand): string {
  const tool = (OWN_TOOLS as Readonly<Record<string, string | undefined>>)[command.keys[0] ?? '']
  return tool === undefined
    ? `Only the user runs ${command.line}, in Seti; it cannot be proposed`
    : `Change it yourself with your ${tool} tool; it needs no request`
}

/**
 * The change an agent's Seti command proposes for itself, read with the reply box's grammar: a
 * host or an MCP server as those requests, anything else as the command. Refuses a line the
 * grammar does not define and one the agent may not propose.
 */
export async function proposedChange(task: Task, line: string): Promise<RequestedChange> {
  const parsed = parseSetiLine(line, await commandWorld(task, 'agent', line))
  if (!parsed.ok) {
    throw new HttpError(400, parsed.reason)
  }
  const { command } = parsed
  if (!command.rule.propose) {
    throw new HttpError(403, proposalRefusal(command))
  }
  const [name, target, key = '', op] = command.keys[0] === 'mcp' ? ['access', ...command.keys] : command.keys
  if (name === 'access' && target === 'host' && op === 'add') {
    return { kind: 'allow_host', host: key, port: 443 }
  }
  if (name === 'access' && target === 'mcp' && op === 'on') {
    return { kind: 'mcp_server', server: key }
  }
  return { kind: 'command', line: command.line, description: command.description }
}

/** Runs a command the user allowed, read again against the agent's state now. */
export async function applyCommand(task: Task, line: string): Promise<void> {
  const parsed = parseSetiLine(line, await commandWorld(task, 'user', line))
  if (!parsed.ok) {
    throw new HttpError(409, `${line} no longer applies: ${parsed.reason}`)
  }
  await runSetiCommand(task, parsed.command)
}
