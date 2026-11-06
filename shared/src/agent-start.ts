import { z } from 'zod'
import { attachmentRefs } from './attachments.js'
import { clientSendId } from './client-send.js'
import { prUrl } from './pr-url.js'
import { workspaceId } from './workspaces.js'

/** Planned titles stay this short, so they fit the agent list. */
export const PLANNED_TITLE_MAX = 60

const MAX_REPOS = 10

/** Starts an agent from one message; the planner picks whatever is not pinned here. */
export const startAgentInput = z
  .object({
    prompt: z.string().trim().min(1, 'Type what the agent should do'),
    title: z.string().trim().min(1).max(200).optional(),
    /** Pinned repos, the agent runs in the first; left out, the planner picks them. */
    repo_ids: z
      .array(z.uuid())
      .max(MAX_REPOS, `pick at most ${String(MAX_REPOS)} repos`)
      .refine((ids) => new Set(ids).size === ids.length, 'a repo can only be picked once')
      .optional(),
    /** With pinned repos only; defaults to a worktree so parallel agents do not collide. */
    worktree: z.boolean().optional(),
    /** A pinned existing directory instead of repos. */
    cwd: z.string().trim().min(1).optional(),
    ref: z.string().trim().min(1).optional(),
    pr_urls: z.array(prUrl).max(50).optional(),
    attachments: attachmentRefs,
    /** Left out, the agent joins its parent's workspace when an agent starts it, else the first. */
    workspace_id: workspaceId.optional(),
    /** Tells the agent or EA that starts it when its first turn ends, as an update. */
    notify_when_done: z.boolean().default(false),
    client_id: clientSendId,
  })
  .refine((input) => input.cwd === undefined || input.repo_ids === undefined, {
    path: ['cwd'],
    message: 'send repo_ids or cwd, not both',
  })
export type StartAgentInput = z.input<typeof startAgentInput>
export type StartAgentRequest = z.output<typeof startAgentInput>

/** What the planner answers; names, not ids, and every field checked again on the server. */
export const plannerOutput = z.object({
  title: z.string().trim().default(''),
  repos: z.array(z.string()).default([]),
  worktree: z.boolean().default(true),
  link_packs: z.array(z.string()).default([]),
  unlink_packs: z.array(z.string()).default([]),
  enable_mcp: z.array(z.string()).default([]),
  disable_mcp: z.array(z.string()).default([]),
  ssh_hosts: z.array(z.string()).default([]),
  aws: z.boolean().default(false),
})
export type PlannerOutput = z.output<typeof plannerOutput>

/** How a new agent was set up, shown in its header and recorded in its creation audit event. */
export interface TaskSetup {
  /** `model` when the planner answered; `fallback` when it failed and defaults were used. */
  planner: 'model' | 'fallback'
  /** Why the planner fell back, such as a timeout. */
  fallback_reason: string | null
  repos: string[]
  worktree: boolean
  /** Context packs linked beyond the defaults, and defaults left off. */
  packs_linked: string[]
  packs_unlinked: string[]
  /** MCP servers turned on or off against the defaults. */
  mcp_enabled: string[]
  mcp_disabled: string[]
  /** Access granted beyond the defaults, such as SSH k8s or AWS. */
  access: string[]
  /** What the planner asked for that the rules held back. */
  withheld: string[]
  /** Planning time in milliseconds. */
  ms: number
}

const list = (label: string, names: readonly string[]) => (names.length === 0 ? [] : [`${label} ${names.join(', ')}`])

function where(setup: TaskSetup): string {
  if (setup.repos.length === 0) {
    return 'fresh folder'
  }
  const label = setup.repos.length === 1 ? 'repo' : 'repos'
  return `${label} ${setup.repos.join(', ')}${setup.worktree ? ' (worktree)' : ''}`
}

/** One compact line: where the agent works, then what differs from the defaults. */
export function setupSummary(setup: TaskSetup): string {
  return [
    where(setup),
    ...list('packs', setup.packs_linked),
    ...list('without packs', setup.packs_unlinked),
    ...list('MCP on', setup.mcp_enabled),
    ...list('MCP off', setup.mcp_disabled),
    ...list('access', setup.access),
  ].join('; ')
}
