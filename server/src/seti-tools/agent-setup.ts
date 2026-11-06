import os from 'node:os'
import path from 'node:path'
import { contextPackInput, prUrl, taskRepoInput, type Task } from '@seti/shared'
import { z } from 'zod'
import { createPack, setTaskPacks, setTaskRole } from '../context-changes.js'
import { repos } from '../db.js'
import { openQuerySince } from '../runner.js'
import { contextPacks, taskContextPacks } from '../store/context.js'
import { subtaskBriefs } from '../subtask-cache.js'
import { linkSubtaskPrUrl, unlinkSubtaskPrUrl, updateTask } from '../task-actions.js'
import { addTaskDir, addTaskRepo, removeTaskDir, removeTaskRepo } from '../task-location.js'
import { linkTaskPr, requireTask, unlinkTaskPr } from '../tasks.js'
import { AGENT_INFO_TOOLS } from './agent-info.js'
import { liveTask, pickOne, taskRef } from './refs.js'
import { done, setiTool, ToolRefusal, type ToolContext } from './tool.js'

const NEXT_TURN = 'from its next turn'

/** One of the agent's repos or plain directories, with the directory it has. */
interface Place {
  repo_id: string | null
  name: string
  dir: string
}

const placesOf = (task: Task): Place[] => [
  ...task.repos.map((repo) => ({ repo_id: repo.id, name: repo.slug, dir: repo.dir })),
  ...task.dirs.map((dir) => ({ repo_id: null, name: dir, dir })),
]

const placeRef = z.string().trim().min(1).describe('A repo slug or id, or a directory path, the agent has.')

function findPlace(task: Task, ref: string): Place {
  const places = placesOf(task)
  const wanted = ref.trim()
  return (
    places.find((place) => place.dir === wanted || `${place.dir}/` === wanted) ??
    pickOne(places, ref, `repo or directory of ${task.title}`, (place) => [place.repo_id ?? place.dir, place.name])
  )
}

function expandHome(raw: string): string {
  if (raw === '~') {
    return os.homedir()
  }
  return raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw
}

/** A directory the caller can reach itself; an agent never widens another past its own reach. */
function insideCaller(ctx: ToolContext, raw: string): string {
  const dir = path.resolve(expandHome(raw))
  const mine = [ctx.caller.cwd, ...ctx.caller.repos.map((repo) => repo.dir), ...ctx.caller.dirs].map((d) =>
    path.resolve(d),
  )
  if (!mine.some((root) => dir === root || dir.startsWith(`${root}${path.sep}`))) {
    throw new ToolRefusal(
      `You can add only a directory inside one of your own: ${mine.join(', ')}. Ask @user for others.`,
    )
  }
  return dir
}

const addAgentRepo = setiTool({
  name: 'add_agent_repo',
  description:
    'Let an agent read and edit a registered repo besides where it works, from its next turn: the checkout itself, or a fresh worktree of its own.',
  input: {
    task: taskRef,
    repo: z.string().trim().min(1).describe("The registered repo's slug or id."),
    worktree: taskRepoInput.shape.worktree,
    ref: taskRepoInput.shape.ref.describe('Worktree only: the branch to start from.'),
  },
  run: async ({ task: ref, repo: repoRef, worktree, ref: start }) => {
    const task = await liveTask(ref)
    const repo = pickOne(await repos.list(), repoRef, 'repo', (r) => [r.id, r.slug])
    await addTaskRepo(task, { repo_id: repo.id, worktree, ...(worktree && start !== undefined ? { ref: start } : {}) })
    return done(`Added ${repo.slug} to ${task.title}${worktree ? ' as a worktree' : ''}; it applies ${NEXT_TURN}.`)
  },
})

const addAgentDirectory = setiTool({
  name: 'add_agent_directory',
  description:
    'Let an agent read and edit an existing directory that is not a registered repo, from its next turn. Only a directory inside one of your own; not a dot folder or Seti data.',
  input: { task: taskRef, path: z.string().trim().min(1).describe('An absolute path, or one starting with ~/.') },
  run: async ({ task: ref, path: raw }, ctx) => {
    const task = await liveTask(ref)
    const dir = insideCaller(ctx, raw)
    await addTaskDir(task, dir)
    return done(`Added the directory ${dir} to ${task.title}; it applies ${NEXT_TURN}.`)
  },
})

const removeFromAgent = setiTool({
  name: 'remove_from_agent',
  description:
    'Take a repo or directory off an agent from its next turn. Nothing on disk is deleted; not possible for its working directory.',
  input: { task: taskRef, what: placeRef },
  run: async ({ task: ref, what }) => {
    const task = await liveTask(ref)
    const place = findPlace(task, what)
    if (place.dir === task.cwd) {
      throw new ToolRefusal(
        `${place.name} is where ${task.title} works; make another of its places its working directory first.`,
      )
    }
    await (place.repo_id === null ? removeTaskDir(task, place.dir) : removeTaskRepo(task, place.repo_id))
    return done(`Took ${place.name} off ${task.title}; its files stay.`)
  },
})

const setAgentWorkingDirectory = setiTool({
  name: 'set_agent_working_directory',
  description:
    "Make one of an agent's repos or directories its working directory, such as a repo added to an agent that started without one. The old one stays attached and the conversation carries on at the next turn.",
  input: { task: taskRef, where: placeRef },
  run: async ({ task: ref, where }) => {
    const task = await liveTask(ref)
    const place = findPlace(task, where)
    if (place.dir === task.cwd) {
      return done(`${task.title} already works in ${place.dir}.`)
    }
    await updateTask(task.id, { cwd: place.dir })
    return done(`${task.title} works in ${place.dir} ${NEXT_TURN} and keeps its conversation.`)
  },
})

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
    'Unlink a pull request from an agent or one of its subagents; Seti then never links it to that agent again on its own.',
  input: { task: taskRef, pr: z.string().trim().min(1).describe('The PR URL, or its number.'), subagent: subagentRef },
  run: async ({ task: ref, pr, subagent }) => {
    const task = await liveTask(ref)
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
  addAgentRepo,
  addAgentDirectory,
  removeFromAgent,
  setAgentWorkingDirectory,
  linkPr,
  unlinkPr,
  linkContextPack,
  unlinkContextPack,
  setAgentRole,
  ...AGENT_INFO_TOOLS,
]
