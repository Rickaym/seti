import { z } from 'zod'

export const MCP_CONFIG_SCOPES = ['user', 'local', 'project'] as const
export type McpConfigScope = (typeof MCP_CONFIG_SCOPES)[number]

export const MCP_ADD_TRANSPORTS = ['http', 'sse', 'stdio'] as const
export type McpAddTransport = (typeof MCP_ADD_TRANSPORTS)[number]

export const isRemovableScope = (scope: string | null): scope is McpConfigScope =>
  MCP_CONFIG_SCOPES.some((s) => s === scope)

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1'])

/** Why a pasted OAuth redirect cannot be submitted, or null when it looks like a local callback. */
export function callbackUrlIssue(raw: string): string | null {
  if (!URL.canParse(raw)) {
    return 'Paste the full address, starting with http://localhost'
  }
  const url = new URL(raw)
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    return 'The address must start with http://localhost or http://127.0.0.1'
  }
  if (!url.searchParams.has('code') || !url.searchParams.has('state')) {
    return 'The address has no code and state; copy it after approving access'
  }
  return null
}

const withRepo = { repo_id: z.uuid().optional() }

export const mcpScopeInput = z.object(withRepo)

/** A sign-in's scope; from an agent's access, its task, whose session decides whether it is due. */
export const mcpSignInInput = z.object({ ...withRepo, task_id: z.string().min(1).max(200).optional() })
export type McpSignInInput = z.infer<typeof mcpSignInInput>

export const mcpAuthCompleteInput = z.object({
  callback_url: z
    .string()
    .trim()
    .superRefine((value, ctx) => {
      const issue = callbackUrlIssue(value)
      if (issue !== null) {
        ctx.addIssue({ code: 'custom', message: issue })
      }
    }),
})
export type McpAuthCompleteInput = z.infer<typeof mcpAuthCompleteInput>

export interface McpAuthStart {
  session_id: string
  authorization_url: string
  /** False for claude.ai connectors: approving on claude.ai finishes the sign-in, nothing to paste. */
  callback_expected: boolean
}

export interface McpAuthDone {
  server: string
}

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
const ENV_NAME_PATTERN = /^[A-Za-z_]\w*$/
const LINE_BREAK = /[\r\n\0]/

const pair = (pattern: RegExp, what: string) =>
  z.object({
    key: z.string().trim().regex(pattern, `${what} name is invalid`),
    value: z.string().refine((value) => !LINE_BREAK.test(value), `${what} value cannot contain line breaks`),
  })

const uniqueKeys = (pairs: { key: string }[]) => new Set(pairs.map((p) => p.key)).size === pairs.length

const common = {
  name: z.string().trim().regex(NAME_PATTERN, 'name may only contain letters, numbers, hyphens and underscores'),
  scope: z.enum(MCP_CONFIG_SCOPES),
  ...withRepo,
}

const remote = z.object({
  ...common,
  transport: z.enum(['http', 'sse']),
  url: z.url({ protocol: /^https?$/, error: 'url must be an http or https URL' }),
  headers: z.array(pair(HEADER_NAME_PATTERN, 'Header')).default([]).refine(uniqueKeys, 'Header names must be unique'),
})

const stdio = z.object({
  ...common,
  transport: z.literal('stdio'),
  command: z.string().trim().min(1, 'command is required'),
  args: z.array(z.string().refine((arg) => !LINE_BREAK.test(arg), 'arguments cannot contain line breaks')).default([]),
  env: z
    .array(pair(ENV_NAME_PATTERN, 'Environment variable'))
    .default([])
    .refine(uniqueKeys, 'Environment variable names must be unique'),
})

export const mcpServerInput = z
  .discriminatedUnion('transport', [remote, stdio])
  .refine((input) => input.scope !== 'project' || input.repo_id !== undefined, {
    path: ['repo_id'],
    message: 'project scope needs a repo',
  })
export type McpServerInput = z.input<typeof mcpServerInput>
export type McpServerRequest = z.output<typeof mcpServerInput>

export const mcpServerNameParam = z.object({ name: common.name })

export const mcpServerRemoveQuery = z
  .object({ scope: z.enum(MCP_CONFIG_SCOPES), ...withRepo })
  .refine((input) => input.scope !== 'project' || input.repo_id !== undefined, {
    path: ['repo_id'],
    message: 'project scope needs a repo',
  })

export interface McpServerChange {
  name: string
  scope: McpConfigScope
}

/** An MCP server as Claude Code names it, such as clickup, plugin:slack:slack or claude.ai Gmail. */
export const mcpSelectionName = z
  .string()
  .trim()
  .min(1, 'server name is required')
  .max(200)
  .refine((name) => !/\p{Cc}/u.test(name), 'server names cannot contain control characters')

const MAX_MCP_CHOICES = 200

const mcpNames = z.array(mcpSelectionName).max(MAX_MCP_CHOICES).default([])

/** Servers an agent turns on or off against the defaults, by name; off wins a tie. */
export const mcpChoiceFields = { mcp_enabled: mcpNames, mcp_disabled: mcpNames }

export type McpChoices = Record<string, boolean>

export function toMcpChoices(fields: { mcp_enabled: readonly string[]; mcp_disabled: readonly string[] }): McpChoices {
  return {
    ...Object.fromEntries(fields.mcp_enabled.map((name) => [name, true])),
    ...Object.fromEntries(fields.mcp_disabled.map((name) => [name, false])),
  }
}

export function fromMcpChoices(choices: McpChoices): { mcp_enabled: string[]; mcp_disabled: string[] } {
  const names = (on: boolean) =>
    Object.keys(choices)
      .filter((name) => choices[name] === on)
      .toSorted((a, b) => a.localeCompare(b, 'en'))
  return { mcp_enabled: names(true), mcp_disabled: names(false) }
}

export const mcpDefaultInput = z.object({ enabled: z.boolean() })
export type McpDefaultInput = z.infer<typeof mcpDefaultInput>

export const mcpDefaultParams = z.object({ name: mcpSelectionName })

export const taskMcpInput = z.object(mcpChoiceFields)
export type TaskMcpInput = z.input<typeof taskMcpInput>

/** Where a server comes from, as the capability probe reports it. */
export type McpSelectionKind = 'config' | 'plugin' | 'connector'

/** A server new agents get unless they opt out, or leave out unless they opt in. */
export interface McpSelectionEntry {
  name: string
  kind: McpSelectionKind | null
  default_enabled: boolean
  /** The capability probe lists it; false for a default kept for a server no longer configured. */
  known: boolean
  /** The directories, as ~/path, whose local config alone has it; empty for every other server. */
  local_to: string[]
}

/** One server as an agent gets it: its default, the agent's own choice, and the outcome. */
export interface TaskMcpServer extends McpSelectionEntry {
  choice: boolean | null
  enabled: boolean
  /** A local server of another directory, which the agent gets only when it is turned on. */
  borrowed: boolean
}

/** Whether a server runs for an agent: its choice, else its Default, else `fallback`. */
export const mcpEnabled = (
  name: string,
  defaults: Readonly<Record<string, boolean>>,
  choices: McpChoices,
  fallback = true,
) => choices[name] ?? defaults[name] ?? fallback

/** Where a local server of other directories comes from and whether agents elsewhere get it. */
export function localServerNote(localTo: readonly string[], defaultEnabled: boolean): string {
  const [first, ...rest] = localTo
  const from = rest.length === 0 ? (first ?? '') : `${first ?? ''} and ${String(rest.length)} more`
  return `From ${from}; ${defaultEnabled ? 'on by default' : 'off unless turned on'}`
}
