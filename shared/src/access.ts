import { z } from 'zod'
import { awsRoleName } from './aws.js'
import type { McpSignIn, McpStatus } from './capabilities.js'
import type { SetiControlLevel } from './seti-control.js'

/**
 * What an agent may reach, each with a default for every agent and a per-agent override:
 * ssh hosts of Seti's ssh config, AWS, MCP servers, context packs and Seti plugins.
 */
export const ACCESS_KINDS = ['ssh', 'aws', 'mcp', 'pack', 'plugin'] as const
export type AccessKind = (typeof ACCESS_KINDS)[number]

/** Security settings: only the user changes their defaults and overrides, never the EA. */
export const SECURITY_ACCESS_KINDS: readonly AccessKind[] = ['ssh', 'aws']

export const isSecurityAccess = (kind: AccessKind) => SECURITY_ACCESS_KINDS.includes(kind)

/** The one AWS item's id; AWS has no parts to pick yet. */
export const AWS_ACCESS_ID = 'aws'

/** One thing an agent may reach, as every agent gets it by default. */
export interface AccessDefault {
  kind: AccessKind
  /** The ssh alias, 'aws', the MCP server name, or the pack or plugin id. */
  id: string
  name: string
  /** Where it goes or what it is, such as `10.0.0.9:22 via jump`; null when there is nothing to add. */
  detail: string | null
  default_enabled: boolean
}

/** The same for one agent: its override, if any, and the outcome. */
export interface AccessItem extends AccessDefault {
  /** Null while the agent follows the default. */
  override: boolean | null
  enabled: boolean
  /** SSH only: enabled hosts whose connection passes through this one as a jump host. */
  jump_for: string[]
  /** SSH only: hosts on its way, itself first, without a key, so ssh cannot log in yet. */
  missing_key: string[]
  /** SSH only: the agent's credential bundles it, so it is on whatever the agent's own choice. */
  in_set: boolean
  /** MCP only: how the agent's latest session has the server; null before any session. */
  session: McpSessionState | null
}

/** How a session has an MCP server: its connection, or not_loaded when its config lacks it. */
export interface McpSessionState {
  status: McpStatus | 'not_loaded'
  /** Why it failed or is missing, in plain words; null when nothing is wrong. */
  reason: string | null
  /** The OAuth sign-in Seti offers from Settings or the agent's access. */
  sign_in: McpSignIn
  /** When the session reported it. */
  at: string
}

export interface AccessProfile {
  id: string
  name: string
}

/**
 * What an agent's AWS calls run as: the credential's role when its switch is on, nothing when
 * off or the set has no role, and this machine's own identity when the agent runs unsandboxed.
 */
export type AwsOutcome =
  | { state: 'on' | 'off'; role: string; region: string }
  | { state: 'no_role'; profile: string }
  | { state: 'host'; host_role: string | null }

/** What the agent's GitHub calls carry: its set's tokens, none, or this machine's own login. */
export type GitHubOutcome = { state: 'set'; default: boolean; owners: string[] } | { state: 'none' } | { state: 'host' }

/** The agent's AWS in one line, the same in its settings, its task.md and the EA's view. */
export function awsOutcomeLine(aws: AwsOutcome): string {
  switch (aws.state) {
    case 'on':
      return `AWS: ${awsRoleName(aws.role)} (${aws.region})`
    case 'off':
      return 'AWS: off'
    case 'no_role':
      return `AWS: no role in ${aws.profile}`
    case 'host':
      return aws.host_role === null
        ? "AWS: this machine's own credentials, not the credential"
        : `AWS: this machine's own role (${awsRoleName(aws.host_role)}), not the credential`
  }
}

export function githubOutcomeLine(github: GitHubOutcome): string {
  switch (github.state) {
    case 'set': {
      const owners = github.owners.length === 0 ? [] : [`for ${github.owners.join(', ')}`]
      return `GitHub: ${[...(github.default ? ['token for every owner'] : []), ...owners].join('; ')}`
    }
    case 'none':
      return 'GitHub: no token in this credential'
    case 'host':
      return "GitHub: this machine's own login, not the credential"
  }
}

/** Everything an agent may reach and where each state comes from. */
export interface TaskAccessView {
  task_id: string
  /** SSH, AWS and the credential profile apply only while the agent runs in the sandbox. */
  sandboxed: boolean
  items: AccessItem[]
  profile: AccessProfile
  /** How far the agent's seti MCP tools reach; only the user changes it. */
  seti_control: SetiControlLevel
  /** Allowlist entries the user added for this agent alone, beside the shared list. */
  hosts: string[]
  aws: AwsOutcome
  github: GitHubOutcome
}

const ACCESS_ID_MAX = 255

export const accessRef = {
  kind: z.enum(ACCESS_KINDS),
  id: z
    .string()
    .trim()
    .min(1, 'id is required')
    .max(ACCESS_ID_MAX)
    .refine((id) => !/\p{Cc}/u.test(id), 'ids cannot contain control characters'),
}

/** Turns an item on or off for one agent; null drops the override so the default applies again. */
export const taskAccessInput = z.object({ ...accessRef, enabled: z.boolean().nullable() })
export type TaskAccessInput = z.input<typeof taskAccessInput>

/** Overrides a new agent starts with, besides the defaults. */
export const accessChoices = z
  .array(z.object({ ...accessRef, enabled: z.boolean() }))
  .max(500)
  .default([])
export type AccessChoice = z.output<typeof accessChoices>[number]

/** Sets what every agent without an override gets. */
export const accessDefaultInput = z.object({ ...accessRef, enabled: z.boolean() })
export type AccessDefaultInput = z.input<typeof accessDefaultInput>

/** An item's state for an agent: its override, else the default. */
export const accessEnabled = (item: Pick<AccessItem, 'override' | 'default_enabled'>) =>
  item.override ?? item.default_enabled

/** The override a switch to `enabled` stores: none when it matches the default. */
export const overrideFor = (item: Pick<AccessDefault, 'default_enabled'>, enabled: boolean): boolean | null =>
  enabled === item.default_enabled ? null : enabled
