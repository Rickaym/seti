import {
  PR_SCOPES,
  PREVIEW_LABEL,
  repoInput,
  startAgentInput,
  WARM_CACHE_MAX_MB,
  warmCacheSettingsInput,
  type PullRequest,
  type Repo,
  type WarmCacheStatus,
} from '@seti/shared'
import { z } from 'zod'
import { capOf } from '../agent-cap.js'
import { startAgent } from '../agent-start.js'
import { listContextFiles } from '../context-files.js'
import { repos } from '../db.js'
import { PREVIEWS_OFF, requestPreview } from '../pr-preview.js'
import { findPr, listPrs } from '../prs.js'
import { addRepo, removeRepo, requireRepo, setWarmCaches, updateRepo, warmCacheStatus } from '../repo-registry.js'
import { taskListEntries } from '../task-actions.js'
import { anyTask, pickOne } from './refs.js'
import { done, setiTool, ToolRefusal } from './tool.js'

const PR_URL = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i
const NUMBER = /\d+/g

const prRef = z
  .string()
  .trim()
  .min(1)
  .describe('The PR by URL, repo#number, number, title words, or the agent it is linked to.')

const repoRef = z.string().trim().min(1).describe('The repo by slug (owner/name), name or id.')

const openPrs = async () => (await listPrs('all')).repos.flatMap((group) => group.prs)

/** The PR without its long check details, as list and get answers show it. */
const prBrief = (pr: PullRequest) => ({
  key: pr.key,
  url: pr.url,
  repo: pr.repo_slug,
  number: pr.number,
  title: pr.title,
  author: pr.author,
  draft: pr.draft,
  head_ref: pr.head_ref,
  base_ref: pr.base_ref,
  updated_at: pr.updated_at,
  ci: pr.ci,
  unresolved_threads: pr.unresolved_threads,
  review_decision: pr.review_decision,
  mergeable: pr.mergeable,
  preview: pr.preview.state,
  tasks: pr.tasks,
})

async function prByUrl(prs: readonly PullRequest[], match: RegExpExecArray): Promise<PullRequest> {
  const [, owner = '', name = '', number = ''] = match
  const url = `https://github.com/${owner}/${name}/pull/${number}`
  const found = prs.find((pr) => pr.url.toLowerCase() === url.toLowerCase()) ?? (await findPr(url))
  if (found === null) {
    throw new ToolRefusal(`${owner}/${name}#${number} is merged, closed, or not in a registered repo.`)
  }
  return found
}

function prByNumber(prs: readonly PullRequest[], ref: string, number: number): PullRequest {
  const words = ref
    .toLowerCase()
    .replace(NUMBER, ' ')
    .split(/[^a-z0-9.-]+/)
  const byNumber = prs.filter((pr) => pr.number === number)
  const narrowed = byNumber.filter((pr) => words.some((w) => w.length > 1 && pr.repo_slug.toLowerCase().includes(w)))
  const found = narrowed.length > 0 ? narrowed : byNumber
  if (found.length !== 1 || found[0] === undefined) {
    const shown = found.map((pr) => `${pr.repo_slug}#${String(pr.number)}`).join(', ')
    throw new ToolRefusal(found.length === 0 ? `No open PR #${String(number)}.` : `"${ref}" matches ${shown}.`)
  }
  return found[0]
}

/** The open PR a reference names by URL, number, key or title, or by the agent linked to it. */
async function resolvePr(ref: string): Promise<PullRequest> {
  const prs = await openPrs()
  const url = PR_URL.exec(ref)
  if (url !== null) {
    return prByUrl(prs, url)
  }
  const numbers = ref.match(NUMBER) ?? []
  if (numbers.length === 1) {
    return prByNumber(prs, ref, Number(numbers[0]))
  }
  try {
    return pickOne(prs, ref, 'open PR', (pr) => [pr.key, pr.title])
  } catch (e) {
    const task = await anyTask(ref).catch(() => null)
    const linked = task === null ? [] : prs.filter((pr) => task.pr_urls.includes(pr.url))
    const [only] = linked
    if (only === undefined) {
      throw e
    }
    if (linked.length > 1) {
      throw new ToolRefusal(
        `${task?.title ?? ref} has ${String(linked.length)} open PRs: ${linked.map((pr) => pr.url).join(', ')}.`,
      )
    }
    return only
  }
}

const resolveRepo = async (ref: string): Promise<Repo> =>
  pickOne(await repos.list(), ref, 'repo', (repo) => [repo.id, repo.slug])

const listPrsTool = setiTool({
  name: 'list_prs',
  description:
    'List open pull requests in registered repos, newest first, with CI, unresolved review threads, review, merge state, preview and linked agents. Scope mine (the default) or all.',
  input: { scope: z.enum(PR_SCOPES).default('mine') },
  run: async ({ scope }) => {
    const list = await listPrs(scope)
    const prs = list.repos.flatMap((group) => group.prs).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    return {
      viewer: list.viewer,
      errors: list.repos.flatMap((group) => (group.error === null ? [] : [{ repo: group.slug, error: group.error }])),
      prs: prs.map(prBrief),
    }
  },
})

const getPr = setiTool({
  name: 'get_pr',
  description:
    'One open pull request in detail: checks with failing names, unresolved review threads, review, merge conflicts, labels, preview, related PRs and linked agents.',
  input: { pr: prRef },
  run: async ({ pr: ref }) => {
    const pr = await resolvePr(ref)
    return {
      ...prBrief(pr),
      labels: pr.labels,
      checks: pr.checks.map(({ name, state, url }) => ({ name, state, url })),
      preview: pr.preview,
      related: pr.related,
    }
  },
})

const requestPreviewTool = setiTool({
  name: 'request_preview',
  description: `Request a preview: adds the ${PREVIEW_LABEL} label to an open PR on GitHub, or removes and re-adds it, so the preview workflow deploys its head commit.`,
  input: { pr: prRef },
  run: async ({ pr: ref }) => {
    const pr = await resolvePr(ref)
    const list = await listPrs('all')
    if (!list.previews_on) {
      throw new ToolRefusal(PREVIEWS_OFF)
    }
    const group = list.repos.find((entry) => entry.repo_id === pr.repo_id)
    if (group !== undefined && !group.previews) {
      throw new ToolRefusal(`Seti has no previews for ${pr.repo_slug}, so it offers no Preview action there.`)
    }
    const [owner = '', name = ''] = pr.repo_slug.split('/')
    return requestPreview(owner, name, pr.number)
  },
})

const startAgentFromPr = setiTool({
  name: 'start_agent_from_pr',
  description:
    "Start a new agent in a worktree of an open PR's branch, linked to the PR. It runs sandboxed with at most your own access and Seti control Self, never Full.",
  input: {
    pr: prRef,
    instructions: z.string().trim().min(1).describe('What the new agent should do on the PR.'),
    title: startAgentInput.shape.title,
  },
  run: async ({ pr: ref, instructions, title }, ctx) => {
    const pr = await resolvePr(ref)
    const prompt = [
      `Work on pull request #${String(pr.number)} in ${pr.repo_slug}: ${pr.title}`,
      pr.url,
      '',
      `You are in an isolated worktree checked out at origin/${pr.head_ref} (detached HEAD).`,
      `The PR merges ${pr.head_ref} into ${pr.base_ref}.`,
      `Commit your changes and push them to the PR branch with: git push origin HEAD:${pr.head_ref}`,
      '',
      `Task: ${instructions}`,
    ].join('\n')
    const input = startAgentInput.parse({
      title: title ?? `PR #${String(pr.number)}: ${pr.title}`,
      prompt,
      repo_ids: [pr.repo_id],
      worktree: true,
      ref: pr.head_ref,
      pr_urls: [pr.url],
      workspace_id: ctx.caller.workspace_id,
    })
    const task = await startAgent(input, await capOf(ctx.caller))
    return { id: task.id, title: task.title, status: task.status, cwd: task.cwd, setup: task.setup }
  },
})

const listRepos = setiTool({
  name: 'list_repos',
  description: 'List the repos registered in Seti with their paths and base branches.',
  input: {},
  run: async () => (await repos.list()).map(({ id, slug, path, base_branch }) => ({ id, slug, path, base_branch })),
})

const getRepo = setiTool({
  name: 'get_repo',
  description: 'One registered repo: the agents working in it, its open PRs and its CLAUDE.md files.',
  input: { repo: repoRef },
  run: async ({ repo: ref }) => {
    const repo = await resolveRepo(ref)
    const [agents, list, files] = await Promise.all([taskListEntries(), listPrs('all'), listContextFiles()])
    const group = list.repos.find((entry) => entry.repo_id === repo.id)
    return {
      ...repo,
      agents: agents
        .filter((task) => task.repos.some((entry) => entry.id === repo.id))
        .map(({ id, title, status }) => ({ id, title, status })),
      pr_error: group?.error ?? null,
      prs: (group?.prs ?? []).map(prBrief),
      context_files: files
        .filter((file) => file.key.startsWith(`repo:${repo.id}:`))
        .map(({ key, label, exists, size }) => ({ key, label, exists, size })),
    }
  },
})

const addRepoTool = setiTool({
  name: 'add_repo',
  description: 'Register a local checkout as a repo agents can run in.',
  input: repoInput.shape,
  run: async (input) => addRepo(input),
})

const updateRepoTool = setiTool({
  name: 'update_repo',
  description: "Change a registered repo's path, base branch or slug; what you leave out stays.",
  input: {
    repo: repoRef,
    slug: repoInput.shape.slug.optional(),
    path: repoInput.shape.path.optional(),
    base_branch: repoInput.shape.base_branch.optional(),
  },
  run: async ({ repo: ref, ...change }) => {
    const repo = await resolveRepo(ref)
    const next = {
      slug: change.slug ?? repo.slug,
      path: change.path ?? repo.path,
      base_branch: change.base_branch ?? repo.base_branch,
    }
    if (next.slug === repo.slug && next.path === repo.path && next.base_branch === repo.base_branch) {
      throw new ToolRefusal(`That changes nothing in ${repo.slug}.`)
    }
    return updateRepo(repo.id, next)
  },
})

const removeRepoTool = setiTool({
  name: 'remove_repo',
  description: 'Remove a repo from Seti; its checkout on disk stays.',
  input: { repo: repoRef },
  run: async ({ repo: ref }) => {
    const repo = await resolveRepo(ref)
    await removeRepo(repo.id)
    return done(`Removed ${repo.slug} from Seti; its checkout stays on disk.`)
  },
})

const getWarmCaches = setiTool({
  name: 'get_warm_caches',
  description:
    "A repo's warm caches: whether Seti copies gitignored build caches into each new worktree so an agent's first typecheck starts warm, which patterns, the size cap, and a hint on warming its typecheck.",
  input: { repo: repoRef },
  run: async ({ repo: ref }) => warmCacheStatus(await requireRepo((await resolveRepo(ref)).id)),
})

const patternList = z.array(z.string().trim().min(1)).max(50)

/** The patterns after the change: from the defaults or the current ones, less removed, plus added. */
function nextPatterns(
  status: WarmCacheStatus,
  change: { add?: string[] | undefined; remove?: string[] | undefined; defaults: boolean },
) {
  const base = change.defaults ? [...status.defaults.patterns] : [...status.settings.patterns]
  const unknown = (change.remove ?? []).filter((pattern) => !base.includes(pattern))
  if (unknown.length > 0) {
    const known = base.length === 0 ? 'none' : base.join(', ')
    throw new ToolRefusal(`${unknown.join(', ')} not among the patterns: ${known}.`)
  }
  const kept = base.filter((pattern) => !(change.remove ?? []).includes(pattern))
  return [...kept, ...(change.add ?? []).filter((pattern) => !kept.includes(pattern))]
}

const setWarmCachesTool = setiTool({
  name: 'set_warm_caches',
  description:
    "Change a repo's warm caches: turn them on or off, add or remove cache patterns, go back to the default patterns, or set the size cap. New worktrees use the change.",
  input: {
    repo: repoRef,
    enabled: z.boolean().optional(),
    add_patterns: patternList.optional(),
    remove_patterns: patternList.optional(),
    default_patterns: z.boolean().default(false),
    max_mb: z.number().int().min(1).max(WARM_CACHE_MAX_MB).optional(),
  },
  run: async ({
    repo: ref,
    enabled,
    add_patterns: add,
    remove_patterns: remove,
    default_patterns: defaults,
    max_mb,
  }) => {
    const repo = await requireRepo((await resolveRepo(ref)).id)
    const status = await warmCacheStatus(repo)
    const body = warmCacheSettingsInput.parse({
      enabled: enabled ?? status.settings.enabled,
      patterns: nextPatterns(status, { add, remove, defaults }),
      max_mb: max_mb ?? status.settings.max_mb,
    })
    const same =
      body.enabled === status.settings.enabled &&
      body.max_mb === status.settings.max_mb &&
      body.patterns.join('\n') === status.settings.patterns.join('\n')
    if (same) {
      throw new ToolRefusal(`That changes nothing in the warm caches of ${repo.slug}.`)
    }
    return setWarmCaches(repo, body)
  },
})

export const PR_TOOLS = [
  listPrsTool,
  getPr,
  requestPreviewTool,
  startAgentFromPr,
  listRepos,
  getRepo,
  addRepoTool,
  updateRepoTool,
  removeRepoTool,
  getWarmCaches,
  setWarmCachesTool,
]
