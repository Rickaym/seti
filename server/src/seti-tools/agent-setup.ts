import { contextPackInput, prUrl, type Task } from '@seti/shared'
import { z } from 'zod'
import { createPack, setTaskPacks, setTaskRole } from '../context-changes.js'
import { openQuerySince } from '../runner.js'
import { contextPacks, taskContextPacks } from '../store/context.js'
import { subtaskBriefs } from '../subtask-cache.js'
import { linkSubtaskPrUrl, unlinkSubtaskPrUrl } from '../task-actions.js'
import { linkTaskPr, requireTask, unlinkTaskPr } from '../tasks.js'
import { stopFollowing } from '../threads/stop.js'
import { AGENT_INFO_TOOLS } from './agent-info.js'
import { liveTask, pickOne, taskRef } from './refs.js'
import { done, setiTool, ToolRefusal } from './tool.js'

const subagentRef = z.string().trim().min(1).optional().describe('A subagent by tool use id or description.')

async function subagentOf(task: Task, ref: string) {
  const subs = await subtaskBriefs(task.id, openQuerySince(task.id))
  return pickOne(subs, ref, `subagent of ${task.title}`, (s) => [s.tool_use_id, s.description])
}

const linkPr = setiTool({
  name: 'link_pr',
  description:
    'Link a pull request to an agent, or to one of its subagents and the agent itself, so its CI, reviews and comments reach the agent as updates. Seti unlinks it once it merges or closes, after a last update saying so.',
  input: { task: taskRef, pr: prUrl.describe('The pull request URL.'), subagent: subagentRef },
  run: async ({ task: ref, pr, subagent }) => {
    const task = await liveTask(ref)
    if (subagent !== undefined) {
      const sub = await subagentOf(task, subagent)
      await linkSubtaskPrUrl(task.id, sub.tool_use_id, pr)
      return done(`Linked ${pr} to the subagent "${sub.description}" of ${task.title}, and to ${task.title}.`)
    }
    await linkTaskPr(task.id, pr)
    return done(`Linked ${pr} to ${task.title}; its updates follow the agent's update mode (${task.input_mode}).`)
  },
})

/** The linked PR a reference names: its URL, or its number when one linked PR has it. */
function linkedPr(urls: readonly string[], ref: string, owner: string): string {
  const number = /^#?(\d+)$/.exec(ref.trim())?.[1]
  const found = urls.filter((url) => url === ref.trim() || (number !== undefined && url.endsWith(`/pull/${number}`)))
  if (found.length === 1 && found[0] !== undefined) {
    return found[0]
  }
  const linked = urls.length === 0 ? 'none' : urls.join(', ')
  throw new ToolRefusal(`"${ref}" names ${found.length === 0 ? 'no' : 'several'} PRs linked to ${owner}: ${linked}.`)
}

const unlinkPr = setiTool({
  name: 'unlink_pr',
  description:
    'Unlink a pull request from an agent or one of its subagents; Seti then never links it to that agent again on its own. Or, with thread instead of pr, stop the agent following a Slack thread it posted in, so replies there no longer reach it.',
  input: {
    task: taskRef,
    pr: z.string().trim().min(1).optional().describe('The PR URL, or its number.'),
    thread: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("A followed thread's thread_id from get_task's followed_threads, instead of pr."),
    subagent: subagentRef,
  },
  run: async ({ task: ref, pr, thread, subagent }) => {
    const task = await liveTask(ref)
    if (thread !== undefined) {
      await stopFollowing(task.id, thread)
      return done(`${task.title} no longer follows thread ${String(thread)}.`)
    }
    if (pr === undefined) {
      throw new ToolRefusal('Give pr to unlink a PR, or thread to stop following a thread.')
    }
    if (subagent !== undefined) {
      const sub = await subagentOf(task, subagent)
      const url = linkedPr(sub.pr_urls, pr, `the subagent "${sub.description}"`)
      await unlinkSubtaskPrUrl(task.id, sub.tool_use_id, url)
      return done(`Unlinked ${url} from the subagent "${sub.description}" of ${task.title}.`)
    }
    const url = linkedPr(task.pr_urls, pr, task.title)
    await unlinkTaskPr(task.id, url)
    return done(`Unlinked ${url} from ${task.title}.`)
  },
})

const packRef = z.string().trim().min(1).describe("The context pack's name or id.")

const linkContextPack = setiTool({
  name: 'link_context_pack',
  description: "Include a reference context pack in an agent's instructions from its next turn.",
  input: { task: taskRef, pack: packRef },
  run: async ({ task: ref, pack: wanted }) => {
    const task = await liveTask(ref)
    const pack = pickOne(await contextPacks.list(), wanted, 'context pack', (p) => [p.id, p.name])
    if (pack.kind === 'role') {
      throw new ToolRefusal(`${pack.name} is a role; give it with set_agent_role, which replaces the current role.`)
    }
    const ids = (await taskContextPacks.list(task.id)).map((p) => p.id)
    if (ids.includes(pack.id)) {
      return done(`${task.title} already includes the pack ${pack.name}.`)
    }
    return setTaskPacks(task, [...ids, pack.id])
  },
})

const unlinkContextPack = setiTool({
  name: 'unlink_context_pack',
  description: "Stop including a context pack in an agent's instructions from its next turn; the pack stays.",
  input: { task: taskRef, pack: packRef },
  run: async ({ task: ref, pack: wanted }) => {
    const task = await liveTask(ref)
    const attached = await taskContextPacks.list(task.id)
    const pack = pickOne(attached, wanted, `context pack of ${task.title}`, (p) => [p.id, p.name])
    return setTaskPacks(
      task,
      attached.filter((p) => p.id !== pack.id).map((p) => p.id),
    )
  },
})

const setAgentRole = setiTool({
  name: 'set_agent_role',
  description:
    'Give an agent a role, replacing the one it has, or remove it. A role is a context pack of kind role, in its system prompt right after the Seti guide from its next turn. Pass exactly one of role (a role pack by name), text (creates a new role pack, named by name) or clear.',
  input: {
    task: taskRef,
    role: z.string().trim().min(1).optional(),
    text: contextPackInput.shape.body.min(1).optional(),
    name: contextPackInput.shape.name.optional(),
    clear: z.boolean().default(false),
  },
  run: async ({ task: ref, role, text, name, clear }) => {
    if ([clear, role !== undefined, text !== undefined].filter(Boolean).length !== 1) {
      throw new ToolRefusal('Pass exactly one of role (a role pack name), text (a new role) or clear true.')
    }
    const task = await liveTask(ref)
    if (clear) {
      return setTaskRole(task, null)
    }
    if (text !== undefined) {
      const fields = { name: (name ?? `${task.title} role`).slice(0, 80), description: '', body: text }
      const created = await createPack(fields, 'role')
      return setTaskRole(await requireTask(task.id), created.value.id)
    }
    const roles = (await contextPacks.list()).filter((pack) => pack.kind === 'role')
    const pack = pickOne(roles, role ?? '', 'role pack', (p) => [p.id, p.name])
    return setTaskRole(task, pack.id)
  },
})

export const AGENT_SETUP_TOOLS = [
  linkPr,
  unlinkPr,
  linkContextPack,
  unlinkContextPack,
  setAgentRole,
  ...AGENT_INFO_TOOLS,
]
