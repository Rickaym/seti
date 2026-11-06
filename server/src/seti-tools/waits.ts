import { awaitTurnEnd } from '../agent-waits.js'
import { isRunning } from '../runner.js'
import { liveTask, taskRef } from './refs.js'
import { done, notSelf, setiTool } from './tool.js'

const awaitAgent = setiTool({
  name: 'await_agent',
  description:
    "Hear back when another agent's current turn ends, or its next one while it is idle: Seti sends you " +
    'an update with its name, how the turn ended and its final message, as it does for PR updates. It ' +
    'does not block: keep working or end your turn. One-shot; you can wait on several agents at once, ' +
    'and archiving either agent cancels the wait.',
  input: { task: taskRef },
  run: async ({ task: ref }, ctx) => {
    const task = await liveTask(ref)
    notSelf(ctx, task, 'wait for')
    await awaitTurnEnd(task)
    const which = isRunning(task.id) ? 'its current turn' : 'its next turn'
    return done(`Seti will send you an update when ${task.title} ends ${which}.`)
  },
})

export const WAIT_TOOLS = [awaitAgent]
