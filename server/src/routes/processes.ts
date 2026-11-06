import { shellParams, stopProcessInput, taskCpuCapInput, taskMemoryCapInput } from '@seti/shared'
import { Hono } from 'hono'
import { agentProcesses } from '../agent-processes.js'
import { setTaskCpuCap, taskCpuCap } from '../cpu-cap.js'
import { ok, valid, validJson } from '../http.js'
import { setTaskMemoryCap, taskMemoryCap } from '../memory-cap.js'
import { readShellOutput, stopProcess, stopShell } from '../process-stop.js'
import { openQuerySince } from '../runner.js'
import { requireTask } from '../tasks.js'

/** An agent's shells and live processes, stopping one of them, and its memory and CPU caps. */
export const taskProcessRoutes = new Hono()
  .get('/:id/processes', async (c) => {
    const task = await requireTask(c.req.param('id'))
    return ok(c, await agentProcesses(task.id, openQuerySince(task.id)))
  })
  .post('/:id/processes/stop', validJson(stopProcessInput), async (c) => {
    const { pid, start_ticks } = c.req.valid('json')
    return ok(c, await stopProcess(c.req.param('id'), pid, start_ticks))
  })
  .get('/:id/shells/:shell_id/output', valid('param', shellParams), async (c) => {
    const { id, shell_id } = c.req.valid('param')
    return ok(c, await readShellOutput(id, shell_id))
  })
  .post('/:id/shells/:shell_id/stop', valid('param', shellParams), async (c) => {
    const { id, shell_id } = c.req.valid('param')
    return ok(c, await stopShell(id, shell_id))
  })
  .get('/:id/memory', async (c) => ok(c, await taskMemoryCap((await requireTask(c.req.param('id'))).id)))
  .put('/:id/memory', validJson(taskMemoryCapInput), async (c) => {
    const task = await requireTask(c.req.param('id'))
    return ok(c, await setTaskMemoryCap(task, c.req.valid('json').cap))
  })
  .get('/:id/cpu', async (c) => ok(c, await taskCpuCap((await requireTask(c.req.param('id'))).id)))
  .put('/:id/cpu', validJson(taskCpuCapInput), async (c) => {
    const task = await requireTask(c.req.param('id'))
    return ok(c, await setTaskCpuCap(task, c.req.valid('json').cap))
  })
