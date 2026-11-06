import {
  awsOutcomeLine,
  chatSearchQuery,
  githubOutcomeLine,
  SUBTASK_STATUSES,
  todoSummary,
  type AgentProcesses,
  type CpuScope,
  type DigestLine,
  type SearchMode,
  type SubtaskBrief,
  type TaskCpuCap,
} from '@seti/shared'
import { z } from 'zod'
import { effectiveAccess } from '../agent-access.js'
import { agentProcesses } from '../agent-processes.js'
import { cpuCapSettings, taskCpuCap } from '../cpu-cap.js'
import { tasks } from '../db.js'
import { memoryCapSettings, taskMemoryCap } from '../memory-cap.js'
import { stopProcess, stopShell } from '../process-stop.js'
import { openQuerySince } from '../runner.js'
import { brief as briefOf } from './agents.js'
import { taskInputs } from '../store/inputs.js'
import { messageSearch } from '../store/search.js'
import { agentTodos, subtaskBriefs } from '../subtask-cache.js'
import { requireSubtask, taskDigest } from '../task-actions.js'
import { anyTask, liveTask, pickOne, taskRef } from './refs.js'
import { setiTool, ToolRefusal } from './tool.js'
import { workspaceNames } from './workspaces.js'

const WAITING_SCAN = 100
const QUEUE_SCAN = 200
const FIND_LIMIT = 20
const DIGEST_LINES = 40
/** get_task's transcript stays under this, so the whole answer fits one tool result. */
const DIGEST_CHARS = 12_000
/** Process kinds an agent may stop: commands and tools, never Claude Code or Seti's helpers. */
const STOPPABLE = new Set(['command', 'tool'])

const listProcesses = setiTool({
  name: 'list_processes',
  description:
    "An agent's background shells (commands it left running, such as dev servers and watches) with status and how long they ran, and the other processes running for it now with CPU and memory.",
  input: { task: taskRef },
  run: async ({ task: ref }) => {
    const task = await anyTask(ref)
    return agentProcesses(task.id, openQuerySince(task.id))
  },
})

type Target =
  { kind: 'shell'; id: string; name: string } | { kind: 'process'; pid: number; ticks: number; name: string }

/** The running shell or stoppable process a pid, shell id, description or command names. */
function targetOf(view: AgentProcesses, ref: string): Target {
  const shells = view.shells.filter((shell) => shell.status === 'running')
  const procs = view.processes.filter((proc) => STOPPABLE.has(proc.kind))
  const shellTarget = (s: (typeof shells)[number]): Target => ({
    kind: 'shell',
    id: s.id,
    name: s.description ?? s.command,
  })
  const procTarget = (p: (typeof procs)[number]): Target => ({
    kind: 'process',
    pid: p.pid,
    ticks: p.start_ticks,
    name: `process ${String(p.ns_pid ?? p.pid)} (${p.command.slice(0, 60)})`,
  })
  if (/^\d+$/.test(ref.trim())) {
    const pid = Number(ref.trim())
    const shell = shells.find((s) => s.pid === pid)
    const proc = procs.find((p) => p.pid === pid || p.ns_pid === pid)
    if (shell !== undefined) {
      return shellTarget(shell)
    }
    if (proc !== undefined) {
      return procTarget(proc)
    }
    throw new ToolRefusal(`No running shell or stoppable process has pid ${ref}; call list_processes.`)
  }
  const shell = shells.find((s) => s.id === ref.trim() || s.description === ref.trim())
  if (shell !== undefined) {
    return shellTarget(shell)
  }
  const named = [
    ...shells.map((s) => ({ key: s.id, name: `${s.description ?? ''} ${s.command}`, target: shellTarget(s) })),
    ...procs.map((p) => ({ key: String(p.pid), name: p.command, target: procTarget(p) })),
  ]
  return pickOne(named, ref, 'running shell or process', (entry) => [entry.key, entry.name]).target
}

const stopProcessTool = setiTool({
  name: 'stop_process',
  description:
    "Stop one of an agent's background shells or processes, and what it started; the agent is told. Not Claude Code itself: stop_task or stop_background_work do that.",
  input: { task: taskRef, target: z.string().trim().min(1).describe('A pid, shell id, description or command.') },
  run: async ({ task: ref, target: wanted }) => {
    const task = await liveTask(ref)
    const target = targetOf(await agentProcesses(task.id, openQuerySince(task.id)), wanted)
    const view =
      target.kind === 'shell'
        ? await stopShell(task.id, target.id)
        : await stopProcess(task.id, target.pid, target.ticks)
    return { stopped: target.name, running: view.running }
  },
})

/** One agent's CPU cap with what its scopes use now and how often the kernel paused them. */
function cpuUse(cap: TaskCpuCap, scopes: readonly CpuScope[]) {
  return {
    ...cap,
    used_percent: scopes.reduce((sum, scope) => sum + scope.usage_percent, 0),
    throttled_now: scopes.some((scope) => scope.throttled_now),
    nr_throttled: scopes.reduce((sum, scope) => sum + scope.nr_throttled, 0),
    throttled_s: Math.round(scopes.reduce((sum, scope) => sum + scope.throttled_usec, 0) / 1e5) / 10,
  }
}

const getMemoryCap = setiTool({
  name: 'get_memory_cap',
  description:
    "The memory and CPU caps every agent runs under, or one agent's caps with what it uses now: above the memory cap the kernel stops the agent's largest process and the rest goes on; at the CPU cap (percent of one core) it is paused until the next period, which shows as throttling.",
  input: { agent: taskRef.optional() },
  run: async ({ agent }) => {
    if (agent === undefined) {
      return { ...(await memoryCapSettings()), cpu: await cpuCapSettings() }
    }
    const task = await anyTask(agent)
    const view = await agentProcesses(task.id, openQuerySince(task.id))
    return {
      ...(await taskMemoryCap(task.id)),
      used_bytes: view.memory.reduce((sum, scope) => sum + scope.current_bytes, 0),
      oom_kills: view.memory.reduce((sum, scope) => sum + scope.oom_kills, 0),
      cpu: cpuUse(await taskCpuCap(task.id), view.cpu),
    }
  },
})

const agentAccess = setiTool({
  name: 'agent_access',
  description:
    'Say what one agent may reach: its SSH hosts, AWS (the role it gets, or why none), MCP servers, context packs, Seti plugins and credentials, each marked as the default for every agent, its own choice, or from its credential.',
  input: { task: taskRef },
  run: async ({ task: ref }) => {
    const view = await effectiveAccess(await anyTask(ref))
    return {
      ...view,
      aws: awsOutcomeLine(view.aws),
      github: githubOutcomeLine(view.github),
      items: view.items.map(({ kind, id, name, detail, enabled, override, default_enabled, missing_key, in_set }) => ({
        kind,
        id,
        name,
        ...(detail === null ? {} : { detail }),
        enabled,
        own_choice: override !== null,
        default_enabled,
        ...(missing_key.length === 0 ? {} : { missing_key }),
        ...(in_set ? { from_credential_set: true } : {}),
      })),
    }
  },
})

const subtaskLine = ({
  tool_use_id,
  description,
  subagent_type,
  status,
  started_at,
  ended_at,
  summary,
}: SubtaskBrief) => ({
  tool_use_id,
  description,
  subagent_type,
  status,
  started_at,
  ended_at,
  summary,
})

const newestFirst = (a: SubtaskBrief, b: SubtaskBrief) => b.started_at.localeCompare(a.started_at)

const countByStatus = (subtasks: readonly SubtaskBrief[]) =>
  Object.fromEntries(
    SUBTASK_STATUSES.map((status) => [status, subtasks.filter((s) => s.status === status).length] as const).filter(
      ([, count]) => count > 0,
    ),
  )

const listSubtasks = setiTool({
  name: 'list_subtasks',
  description:
    'List the subagents an agent started, newest first, with status, what each does and how long it ran, and counts by status.',
  input: {
    task: taskRef,
    status: z.enum(SUBTASK_STATUSES).optional().describe('Only subagents with this status.'),
    limit: z.number().int().min(1).max(200).default(30).describe('Most subagents to list; default 30.'),
  },
  run: async ({ task: ref, status, limit }) => {
    const task = await anyTask(ref)
    const all = await subtaskBriefs(task.id, openQuerySince(task.id))
    const matching = all.filter((s) => status === undefined || s.status === status).toSorted(newestFirst)
    return {
      total: all.length,
      counts: countByStatus(all),
      ...(matching.length > limit ? { listed: `newest ${String(limit)} of ${String(matching.length)}` } : {}),
      subtasks: matching.slice(0, limit).map(subtaskLine),
    }
  },
})

/** The newest digest lines within the budget, oldest first, as `time kind: text` in UTC. */
function digestText(lines: readonly DigestLine[]): string[] {
  const kept: string[] = []
  let chars = 0
  for (const line of lines.toReversed()) {
    const text = `${line.at.slice(0, 16)}Z ${line.kind}: ${line.text}`
    chars += text.length
    if (kept.length > 0 && chars > DIGEST_CHARS) {
      break
    }
    kept.push(text)
  }
  return kept.toReversed()
}

const getTask = setiTool({
  name: 'get_task',
  description:
    'One agent in detail: status, a condensed recent transcript, its todo list, updates waiting for it, running subagents and counts of the rest, where it works, its setup, cost at API prices and linked PRs. For an earlier day use read_transcript.',
  input: { task: taskRef },
  run: async ({ task: ref }) => {
    const task = await anyTask(ref)
    const [subtasks, names, digest, todos, waiting] = await Promise.all([
      subtaskBriefs(task.id, openQuerySince(task.id)),
      workspaceNames(),
      taskDigest(task.id, DIGEST_LINES),
      agentTodos(task.id),
      taskInputs.pending(task.id, QUEUE_SCAN),
    ])
    const running = subtasks.filter((s) => s.status === 'running')
    const { id, title, status, ...rest } = briefOf(task)
    return {
      id,
      title,
      status,
      workspace: names.get(task.workspace_id) ?? null,
      transcript: digestText(digest.lines),
      todos: todoSummary(todos),
      waiting_updates: waiting.length,
      subtasks: {
        counts: countByStatus(subtasks),
        running: running.map(({ tool_use_id, description, started_at }) => ({ tool_use_id, description, started_at })),
        ...(subtasks.length > running.length ? { others: 'list_subtasks lists them' } : {}),
      },
      ...rest,
      dirs: task.dirs,
      input_mode: task.input_mode,
      cost_usd: task.cost_usd,
      setup: task.setup,
    }
  },
})

const getSubtask = setiTool({
  name: 'get_subtask',
  description:
    "One subagent of an agent: its brief, progress while running, and its report. 'latest' names the newest.",
  input: { task: taskRef, subtask: z.string().trim().min(1).describe('Tool use id, description, or latest.') },
  run: async ({ task: ref, subtask }) => {
    const task = await anyTask(ref)
    const subs = await subtaskBriefs(task.id, openQuerySince(task.id))
    const latest = subs.toSorted((a, b) => b.started_at.localeCompare(a.started_at))[0]
    const brief =
      subtask.toLowerCase() === 'latest' && latest !== undefined
        ? latest
        : pickOne(subs, subtask, `subagent of ${task.title}`, (s) => [s.tool_use_id, s.description])
    const detail = await requireSubtask(task.id, brief.tool_use_id)
    const { prompt, result, progress, usage, background, pr_urls: prs } = detail
    return { ...subtaskLine(detail), background, usage, progress, prompt, result, pr_urls: prs }
  },
})

const findInTranscript = setiTool({
  name: 'find_in_transcript',
  description:
    "Find messages in one agent's transcript with some text, however far back, newest first, each with a line around the match. It searches the user's prompts, updates and the agent's replies; set include_tools to search tool calls and output, shell runs and Seti's notes too.",
  input: {
    task: taskRef,
    query: z.string().trim().min(1),
    whole_words: z.boolean().default(false),
    include_tools: z.boolean().default(false),
  },
  run: async ({ task: ref, query, whole_words: words, include_tools: tools }) => {
    const task = await liveTask(ref)
    const mode: SearchMode = words ? 'words' : 'text'
    return messageSearch.search(task.id, { ...chatSearchQuery.parse({ q: query, mode, limit: FIND_LIMIT }), tools })
  },
})

const listWaitingUpdates = setiTool({
  name: 'list_waiting_updates',
  description:
    'Updates (PR CI, reviews, comments, group chat, channel events) waiting to be handed to agents, across all agents.',
  input: {},
  run: async () => {
    const all = await tasks.list()
    const waiting = await Promise.all(
      all.map(async (task) => ({ task, updates: await taskInputs.pending(task.id, WAITING_SCAN) })),
    )
    return waiting
      .filter(({ updates }) => updates.length > 0)
      .map(({ task, updates }) => ({
        task: { id: task.id, title: task.title, status: task.status, input_mode: task.input_mode },
        count: updates.length,
        latest: updates.slice(-3).map(({ source, kind, subject, title }) => ({ source, kind, subject, title })),
      }))
  },
})

export const AGENT_INFO_TOOLS = [
  getTask,
  listProcesses,
  stopProcessTool,
  getMemoryCap,
  agentAccess,
  listSubtasks,
  getSubtask,
  findInTranscript,
  listWaitingUpdates,
]
