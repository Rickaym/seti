import { parseSetiLine, setiCommandInput, type SetiCommandResult } from '@seti/shared'
import { Hono } from 'hono'
import { refuseDelegates } from '../ea-guard.js'
import { HttpError, ok, validJson } from '../http.js'
import { runSetiCommand } from '../seti-commands/run.js'
import { commandWorld } from '../seti-commands/world.js'
import { requireTask } from '../tasks.js'

/**
 * A Seti command the user submits from an agent's reply box. Seti reads the line again with the
 * parser the reply box completes with, and runs it through the settings' own functions.
 */
export const setiCommandRoutes = new Hono().post('/:id/seti-commands', validJson(setiCommandInput), async (c) => {
  refuseDelegates("run Seti commands from an agent's reply box")
  const task = await requireTask(c.req.param('id'))
  const { line, confirmed } = c.req.valid('json')
  const parsed = parseSetiLine(line, await commandWorld(task, 'user', line))
  if (!parsed.ok) {
    throw new HttpError(400, parsed.reason)
  }
  const { command } = parsed
  if (command.rule.confirm && !confirmed) {
    throw new HttpError(409, `Confirm first: ${command.description}`)
  }
  await runSetiCommand(task, command)
  return ok(c, { line: command.line, description: command.description } satisfies SetiCommandResult)
})
