import { z } from 'zod'
import { attachmentRefs } from './attachments.js'
import { clientSendId } from './client-send.js'
import { prUrl } from './pr-url.js'
import { runtimeFields } from './runtimes/picks.js'
import { workspaceId } from './workspaces.js'

/** Planned titles stay this short, so they fit the agent list. */
export const PLANNED_TITLE_MAX = 60

/** Starts an agent from one message; the planner picks whatever is not pinned here. */
export const startAgentInput = z.object({
  prompt: z.string().trim().min(1, 'Type what the agent should do'),
  title: z.string().trim().min(1).max(200).optional(),
  pr_urls: z.array(prUrl).max(50).optional(),
  attachments: attachmentRefs,
  /** Left out, the agent joins its parent's workspace when an agent starts it, else the first. */
  workspace_id: workspaceId.optional(),
  /** Off starts it outside the sandbox, which only the user may; agents' starts stay sandboxed. */
  sandbox: z.boolean().default(true),
  /** Tells the agent or EA that starts it when its first turn ends, as an update. */
  notify_when_done: z.boolean().default(false),
  client_id: clientSendId,
  /** An agent whose work the new one carries on or helps with; a brief of it follows the prompt. */
  brief_of: z.string().trim().min(1).max(64).optional(),
  /** A role pack by name; its runtime and model apply where the start names neither. */
  role: z.string().trim().min(1).max(80).optional(),
  /** The runtime the agent runs on, Codex only while the user turned it on, and its model. */
  ...runtimeFields,
})
export type StartAgentInput = z.input<typeof startAgentInput>
export type StartAgentRequest = z.output<typeof startAgentInput>

/** What the planner answers: names, not ids, checked again on the server; it turns nothing on. */
export const plannerOutput = z.object({
  title: z.string().trim().default(''),
  link_packs: z.array(z.string()).default([]),
  unlink_packs: z.array(z.string()).default([]),
  disable_mcp: z.array(z.string()).default([]),
})
export type PlannerOutput = z.output<typeof plannerOutput>

/** How a new agent was set up, shown in its header and recorded in its creation audit event. */
export interface TaskSetup {
  /** `model` when the planner answered; `fallback` when it failed and defaults were used. */
  planner: 'model' | 'fallback'
  /** Why the planner fell back, such as a timeout, or why its title was not used. */
  fallback_reason: string | null
  /** Context packs linked beyond the defaults, and defaults left off. */
  packs_linked: string[]
  packs_unlinked: string[]
  /** MCP servers on by default that the planner turned off. */
  mcp_disabled: string[]
  /** What the start held back, such as access beyond what a starting agent has. */
  withheld: string[]
  /** Planning time in milliseconds. */
  ms: number
}

const list = (label: string, names: readonly string[]) => (names.length === 0 ? [] : [`${label} ${names.join(', ')}`])

/** One compact line: the agent's fresh folder, then what differs from the defaults. */
export function setupSummary(setup: TaskSetup): string {
  return [
    'fresh folder',
    ...list('packs', setup.packs_linked),
    ...list('without packs', setup.packs_unlinked),
    ...list('MCP off', setup.mcp_disabled),
  ].join('; ')
}
