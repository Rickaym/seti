import fs from 'node:fs'
import path from 'node:path'
import { commandScopeQuery, shellInput, taskParams, type AuditKind, type Task } from '@seti/shared'
import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { audit } from '../audit.js'
import { capabilityCache } from '../capabilities.js'
import { commandCatalog, nearbyDirs } from '../commands.js'
import { notEa } from '../ea-guard.js'
import { HttpError, ok, valid, validJson } from '../http.js'
import { runShell, stopShell } from '../shell.js'
import { inLane } from '../task-lane.js'
import { requireTask } from '../tasks.js'
import { scopeCwd } from './capabilities.js'

const catalogFor = async (cwd: string, agent = false) =>
  commandCatalog(await capabilityCache.lookup(cwd, await nearbyDirs(cwd)), { agent })

async function auditShell(kind: Extract<AuditKind, `task.shell_${string}`>, task: Task, command: string) {
  const verb = kind === 'task.shell_run' ? 'Ran' : 'Stopped'
  await audit.record({
    actor: 'user',
    kind,
    subject_type: 'task',
    subject_id: task.id,
    summary: `${verb} shell command in task "${task.title}": ${command}`,
    detail: { title: task.title, command, cwd: task.cwd },
  })
}

const validTask = valid('param', taskParams)

/** Slash command lists, `!` shell runs and their cancellation, mounted under /api/tasks. */
export const taskComposerRoutes = new Hono()
  .get('/:id/commands', compress(), validTask, async (c) =>
    ok(c, await catalogFor((await requireTask(c.req.valid('param').id)).cwd, true)),
  )
  .post('/:id/shell', notEa('run shell commands'), validTask, validJson(shellInput), async (c) => {
    const task = await requireTask(c.req.valid('param').id)
    const { command } = c.req.valid('json')
    const progress = await inLane(task.id, async () => runShell(task, command))
    await auditShell('task.shell_run', task, command)
    return ok(c, progress)
  })
  .post('/:id/shell/stop', validTask, async (c) => {
    const task = await requireTask(c.req.valid('param').id)
    const progress = stopShell(task.id)
    await auditShell('task.shell_stopped', task, progress.command)
    return ok(c, progress)
  })

async function scopeDirectory(query: { repo_id?: string | undefined; cwd?: string | undefined }): Promise<string> {
  if (query.repo_id !== undefined || query.cwd === undefined) {
    return scopeCwd(query.repo_id)
  }
  if (!path.isAbsolute(query.cwd) || !fs.existsSync(query.cwd)) {
    throw new HttpError(400, 'Working directory does not exist')
  }
  return query.cwd
}

/** Slash commands for a directory before any task exists there, as in the New task dialog. */
export const commandRoutes = new Hono().get('/', compress(), valid('query', commandScopeQuery), async (c) =>
  ok(c, await catalogFor(await scopeDirectory(c.req.valid('query')))),
)
