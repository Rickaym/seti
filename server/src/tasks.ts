import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import {
  extraDirs,
  fromMcpChoices,
  toMcpChoices,
  agentColorWord,
  type AgentColor,
  type AuditActor,
  setupSummary,
  SETI_CONTROL_LABELS,
  type SetiControlLevel,
  type Repo,
  type Task,
  type TaskRequest,
  type TaskSetup,
} from '@seti/shared'
import { accessSummary, applyStartAccess, awsWithProfile, planStartAccess } from './agent-access.js'
import { audit, auditPrLink } from './audit.js'
import { capabilityCache } from './capabilities.js'
import { repos, tasks, type BackfillMessage } from './db.js'
import { promptAuthor, refuseAgent, refuseOtherAgent } from './ea-guard.js'
import { watchPrLinked } from './ea-watch.js'
import { createWorktree, removeWorktree } from './git.js'
import { HttpError } from './http.js'
import { errorCode } from './pg.js'
import { taskPluginNames } from './plugins.js'
import { publish, runTurn } from './runner.js'
import { reloadSshAgents } from './ssh-agent.js'
import { contextPacks, taskContextPacks } from './store/context.js'
import { profiles } from './store/credentials.js'
import { taskMcpChoices } from './store/mcp.js'
import { setiPlugins, taskPluginChoices } from './store/plugins.js'
import { prDismissals } from './store/pr-discovery.js'
import { createScratchDir, worktreeName } from './task-location.js'
import { rehandleAfterRename } from './team-rename.js'
import { placeAttachments } from './uploads.js'
import { recordSeeds, seedWorktrees, type SeedTarget } from './warm-caches.js'
import { startWorkspace } from './workspaces.js'

export async function requireTask(id: string): Promise<Task> {
  const task = await tasks.get(id)
  if (!task) {
    throw new HttpError(404, 'Task not found')
  }
  return task
}

async function requireRepos(ids: readonly string[]): Promise<Repo[]> {
  const found: Repo[] = []
  for (const id of ids) {
    const repo = await repos.get(id)
    if (!repo) {
      throw new HttpError(400, 'Unknown repo')
    }
    found.push(repo)
  }
  return found
}

interface PlacedRepo {
  repo: Repo
  dir: string
}

async function removePlaced(placed: readonly PlacedRepo[]): Promise<void> {
  await Promise.allSettled(placed.map(async ({ repo, dir }) => removeWorktree(repo.path, dir)))
}

/** One detached worktree per repo; the start ref applies to the first, the rest use their base. */
async function createWorktrees(taskId: string, list: readonly Repo[], ref: string | undefined): Promise<PlacedRepo[]> {
  const placed: PlacedRepo[] = []
  const names = new Set<string>()
  try {
    for (const [index, repo] of list.entries()) {
      const name = worktreeName(repo, taskId, (candidate) => names.has(candidate))
      names.add(name)
      const start = index === 0 ? (ref ?? repo.base_branch) : repo.base_branch
      placed.push({ repo, dir: await createWorktree(repo.path, start, name) })
    }
  } catch (e) {
    await removePlaced(placed)
    throw e
  }
  return placed
}

async function placeRepos(taskId: string, input: TaskRequest): Promise<PlacedRepo[]> {
  const list = await requireRepos(input.repo_ids)
  if (input.worktree) {
    return createWorktrees(taskId, list, input.ref)
  }
  return list.map((repo) => ({ repo, dir: repo.path }))
}

interface Location {
  cwd: string
  repo_id: string | null
  worktree: boolean
  extras: { repo_id: string; dir: string }[]
  /** Worktrees made for the task, to seed with build caches. */
  made: SeedTarget[]
}

/** Repos when picked, else the directory given, else a fresh directory of the agent's own. */
async function resolveLocation(taskId: string, input: TaskRequest): Promise<Location> {
  const placed = await placeRepos(taskId, input)
  const [primary, ...extras] = placed
  if (primary !== undefined) {
    return {
      cwd: primary.dir,
      repo_id: primary.repo.id,
      worktree: input.worktree,
      extras: extras.map(({ repo, dir }) => ({ repo_id: repo.id, dir })),
      made: input.worktree ? placed : [],
    }
  }
  if (input.cwd === undefined) {
    return { cwd: createScratchDir(taskId, input.title), repo_id: null, worktree: false, extras: [], made: [] }
  }
  const cwd = input.cwd
  if (cwd === '' || !fs.existsSync(cwd)) {
    throw new HttpError(400, 'Pick a repo or a working directory that exists')
  }
  return { cwd, repo_id: null, worktree: false, extras: [], made: [] }
}

const here = (task: Task, dir: string) => (dir === task.cwd ? ' (your working directory)' : '')

/** Lists the directories of a task that spans several, so the agent knows where each one is. */
export async function taskReposContext(taskId: string): Promise<string | null> {
  const task = await tasks.get(taskId)
  if (!task || extraDirs(task).length === 0) {
    return null
  }
  const inRepos = task.repos.some((repo) => repo.dir === task.cwd)
  const lines = [
    ...(inRepos ? [] : [`- ${task.cwd} (your working directory)`]),
    ...task.repos.map((repo) => `- ${repo.slug}: ${repo.dir}${here(task, repo.dir)}`),
    ...task.dirs.map((dir) => `- ${dir}`),
  ]
  const intro = 'This task spans several directories. You can read and edit all of them:'
  const worktrees = task.repos.filter((repo) => repo.worktree).map((repo) => repo.slug)
  const branches =
    worktrees.length === 0
      ? []
      : [`Seti made a detached worktree of ${worktrees.join(', ')}; create a branch in each one you change.`]
  return [intro, ...lines, ...branches].join('\n')
}

function plannedNote(setup: TaskSetup | null): string {
  if (setup === null) {
    return ''
  }
  return `; ${setup.planner === 'fallback' ? 'planned with defaults' : 'planned'}: ${setupSummary(setup)}`
}

/** The plan in the flat shape audit details take. */
function planDetail(setup: TaskSetup | null) {
  if (setup === null) {
    return {}
  }
  return {
    planner: setup.planner,
    planner_ms: setup.ms,
    planned: setupSummary(setup),
    ...(setup.fallback_reason === null ? {} : { planner_error: setup.fallback_reason }),
    ...(setup.withheld.length === 0 ? {} : { withheld: setup.withheld }),
  }
}

async function auditCreated(task: Task, actor: AuditActor): Promise<void> {
  const packs = (await taskContextPacks.list(task.id)).map((pack) => pack.name)
  const plugins = await taskPluginNames(await taskPluginChoices.get(task.id))
  const mcp = fromMcpChoices(await taskMcpChoices.get(task.id))
  const slugs = task.repos.map((repo) => repo.slug)
  const where = slugs.length === 0 ? task.cwd : slugs.join(' + ')
  await audit.record({
    actor,
    kind: 'task.created',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Created task "${task.title}" in ${where}${task.worktree ? ' (worktree)' : ''}${task.sandbox ? '' : ', unsandboxed'}${plannedNote(task.setup)}`,
    detail: {
      title: task.title,
      repo: task.repo_slug,
      repos: slugs,
      cwd: task.cwd,
      worktree: task.worktree,
      sandbox: task.sandbox,
      seti_control: task.seti_control,
      color: task.color,
      ...(await accessSummary(task)),
      profile: (await profiles.get(task.profile_id))?.name ?? task.profile_id,
      context_packs: packs,
      ...plugins,
      ...mcp,
      ...(task.pr_urls.length === 0 ? {} : { pr_urls: task.pr_urls }),
      ...planDetail(task.setup),
    },
  })
}

/** Creates the task row and its working directories, calls onCreated, then starts the first turn. */
export async function startTask(
  input: TaskRequest,
  onCreated?: (taskId: string) => void | Promise<void>,
  actor: AuditActor = 'user',
): Promise<Task> {
  const packIds = input.context_pack_ids ?? (await contextPacks.linkedByDefault())
  await contextPacks.assertLinkable(packIds)
  await setiPlugins.assertExist(input.disabled_plugin_ids)
  await requireProfile(input.profile_id)
  const access = await planStartAccess(input.access)
  const workspace = await startWorkspace(input.workspace_id)
  const id = randomUUID()
  const location = await resolveLocation(id, input)
  const seeding = seedWorktrees(location.made)
  await tasks.insert(
    {
      id,
      title: input.title,
      repo_id: location.repo_id,
      cwd: location.cwd,
      worktree: location.worktree,
      sandbox: input.sandbox,
      profile_id: input.profile_id,
      seti_control: input.seti_control,
      pr_urls: [...new Set(input.pr_urls ?? [])],
      setup: input.setup ?? null,
      workspace_id: workspace.id,
    },
    location.extras,
  )
  capabilityCache.prewarm(location.cwd)
  await taskContextPacks.set(id, packIds)
  await taskPluginChoices.setOptOuts(id, input.disabled_plugin_ids)
  await taskMcpChoices.set(id, toMcpChoices(input))
  await applyStartAccess(await requireTask(id), access)
  await auditCreated(await requireTask(id), actor)
  await recordSeeds({ id, title: input.title }, location.made, await seeding, actor)
  await onCreated?.(id)
  const first = await placeAttachments(id, input.prompt, input.attachments ?? [])
  await runTurn(id, first.prompt, { attachments: first.attachments, from: promptAuthor() })
  return requireTask(id)
}

export interface ImportedTaskInput {
  title: string
  workspace_id?: string
  repo_id: string | null
  cwd: string
  pr_urls: string[]
  session_id: string
  source_session_id: string
  history: readonly BackfillMessage[]
}

const isUniqueViolation = (e: unknown) => errorCode(e) === '23505'

/** Creates an idle task that resumes a fork of an existing session, with its transcript. */
export async function createImportedTask(input: ImportedTaskInput): Promise<Task> {
  const id = randomUUID()
  const { history, ...fields } = input
  await startWorkspace(input.workspace_id)
  try {
    await tasks.insertImported({ ...fields, pr_urls: [...new Set(fields.pr_urls)], id, worktree: false }, history)
  } catch (e) {
    throw isUniqueViolation(e) ? new HttpError(409, 'Session is already imported') : e
  }
  await taskContextPacks.set(id, await contextPacks.linkedByDefault())
  const task = await requireTask(id)
  capabilityCache.prewarm(task.cwd)
  await audit.record({
    actor: 'user',
    kind: 'task.imported',
    subject_type: 'task',
    subject_id: id,
    summary: `Imported session "${task.title}" into ${task.repo_slug ?? task.cwd}`,
    detail: {
      title: task.title,
      repo: task.repo_slug,
      cwd: task.cwd,
      source_session_id: input.source_session_id,
      session_id: input.session_id,
      color: task.color,
      pr_urls: task.pr_urls,
      messages: history.length,
    },
  })
  return task
}

/** Pins a long-running task to the top of the list and out of archiving and cleanup, or unpins it. */
export async function setTaskPinned(task: Task, pinned: boolean): Promise<void> {
  if (task.pinned === pinned) {
    return
  }
  await tasks.setPinned(task.id, pinned)
  await audit.record({
    actor: 'user',
    kind: 'task.pinned_changed',
    subject_type: 'task',
    subject_id: task.id,
    summary: `${pinned ? 'Pinned' : 'Unpinned'} task "${task.title}"`,
    detail: { title: task.title, pinned },
  })
}

export async function setTaskColor(task: Task, color: AgentColor | null): Promise<void> {
  if (task.color === color) {
    return
  }
  await tasks.setColor(task.id, color)
  await audit.record({
    actor: 'user',
    kind: 'task.color_changed',
    subject_type: 'task',
    subject_id: task.id,
    summary:
      color === null
        ? `Cleared the colour of task "${task.title}"`
        : `Coloured task "${task.title}" ${agentColorWord(color)}`,
    detail: { title: task.title, color, previous_color: task.color },
  })
}

/** Renames a task; its group chat handle stays as it was. */
export async function renameTask(task: Task, title: string): Promise<void> {
  if (task.title === title) {
    return
  }
  await tasks.setTitle(task.id, title)
  await audit.record({
    actor: 'user',
    kind: 'task.renamed',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Renamed task "${task.title}" to "${title}"`,
    detail: { title, previous_title: task.title },
  })
  await rehandleAfterRename({ id: task.id, title })
}

/** Turns a task's sandbox on or off; the change applies at its next turn. */
export async function setTaskSandbox(task: Task, on: boolean): Promise<void> {
  refuseAgent("change an agent's sandbox")
  if (task.sandbox === on) {
    return
  }
  await tasks.setSandbox(task.id, on)
  await audit.record({
    actor: 'user',
    kind: 'task.access_changed',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Turned the sandbox ${on ? 'on' : 'off'} for task "${task.title}"`,
    detail: { title: task.title, sandbox: on },
  })
}

/**
 * Sets how far a task's seti MCP tools reach; its session restarts at the next turn. Returns the
 * level it had when that changed anything, else null.
 */
export async function setTaskSetiControl(task: Task, level: SetiControlLevel): Promise<SetiControlLevel | null> {
  refuseAgent("change an agent's Seti control")
  if (task.seti_control === level) {
    return null
  }
  await tasks.setSetiControl(task.id, level)
  await audit.record({
    actor: 'user',
    kind: 'task.access_changed',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Set Seti control of task "${task.title}" to ${SETI_CONTROL_LABELS[level]}`,
    detail: { title: task.title, seti_control: level, previous: task.seti_control },
  })
  return task.seti_control
}

async function requireProfile(id: string) {
  const profile = await profiles.get(id)
  if (profile === undefined) {
    throw new HttpError(400, 'No credential with that id')
  }
  return profile
}

/** Gives a task another credential profile, with AWS on when it has a role, from the next turn. */
export async function setTaskProfile(task: Task, profileId: string, actor: AuditActor = 'user'): Promise<void> {
  refuseAgent("change an agent's credentials")
  if (task.profile_id === profileId) {
    return
  }
  const profile = await requireProfile(profileId)
  await tasks.setProfile(task.id, profileId)
  await audit.record({
    actor,
    kind: 'task.profile_changed',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Gave task "${task.title}" the credentials ${profile.name}`,
    detail: { title: task.title, profile: profile.name, profile_id: profile.id },
  })
  await awsWithProfile({ ...task, profile_id: profileId }, actor)
  await reloadSshAgents()
}

/** Links a PR by hand, which also lifts an earlier dismissal of it. */
export async function linkTaskPr(taskId: string, url: string): Promise<boolean> {
  refuseOtherAgent(taskId)
  await prDismissals.remove(taskId, url)
  const linked = await tasks.linkPr(taskId, url, 'user')
  if (linked) {
    await auditPrLink({ actor: 'user', taskId, url, linked: true })
    await watchPrLinked(taskId, url)
  }
  return linked
}

/** Unlinks a PR and remembers it, so Seti never links it to this task again on its own. */
export async function unlinkTaskPr(taskId: string, url: string): Promise<boolean> {
  refuseOtherAgent(taskId)
  const unlinked = await tasks.unlinkPr(taskId, url)
  if (unlinked) {
    await prDismissals.add(taskId, url)
    await auditPrLink({ actor: 'user', taskId, url, linked: false })
  }
  return unlinked
}

/** Links a PR the transcript shows the task opened or pushed to, unless the user removed it. */
export async function linkDiscoveredPr(taskId: string, url: string, found: string): Promise<boolean> {
  if ((await prDismissals.list(taskId)).has(url) || !(await tasks.linkPr(taskId, url, 'discovered'))) {
    return false
  }
  await auditPrLink({ actor: 'system', taskId, url, linked: true, found })
  await watchPrLinked(taskId, url)
  publish(taskId, { type: 'prs' })
  return true
}
