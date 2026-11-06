import { z } from 'zod'

/** Hosts sandboxed agents reach by default: GitHub and the package registries. */
export const DEFAULT_ALLOWED_DOMAINS = [
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'uploads.github.com',
  '*.githubusercontent.com',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'astral.sh',
  '*.astral.sh',
  'nodejs.org',
  'cdn.playwright.dev',
  'playwright.download.prss.microsoft.com',
  'playwright.azureedge.net',
] as const

const DOMAIN_ENTRY = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/
const PATH_ENTRY = /^(~\/|\/)[^\0\n\r]*$/
const MAX_DOMAINS = 200
const MAX_PATHS = 100

export const domainEntry = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(DOMAIN_ENTRY, 'Use a host such as github.com or *.example.com, with an optional :port')

const pathEntry = z
  .string()
  .trim()
  .max(1024)
  .regex(PATH_ENTRY, 'Use an absolute path or one that starts with ~/')
  .refine((entry) => !entry.split('/').includes('..'), 'Paths cannot contain ..')

const unique = <T>(items: T[]) => [...new Set(items)]

/** Whether agents run in Seti's sandbox, and the hosts and paths it allows or hides. */
export const sandboxPolicyInput = z.object({
  enabled: z.boolean(),
  allowed_domains: z.array(domainEntry).max(MAX_DOMAINS).transform(unique),
  hidden_paths: z.array(pathEntry).max(MAX_PATHS).transform(unique),
})
export type SandboxPolicyInput = z.input<typeof sandboxPolicyInput>

export interface SandboxPolicy extends z.output<typeof sandboxPolicyInput> {
  updated_at: string | null
}

export const SANDBOX_POLICY_DEFAULT: SandboxPolicy = {
  enabled: true,
  allowed_domains: [...DEFAULT_ALLOWED_DOMAINS],
  hidden_paths: [],
  updated_at: null,
}

/** Whether the egress proxy has a fine-grained token from Secrets for agents' GitHub requests. */
export type GitHubTokenMode = 'agent' | 'none'

/** Where sandboxed agents' Claude credential comes from: the token in Secrets or the host login. */
export type ClaudeCredentialMode = 'token' | 'login' | 'none'

/** Whether sandboxed agents can use an MCP server: yes, after a new sign-in on the host, or not. */
export type SandboxMcpState = 'ok' | 'needs_login' | 'refused'

/** How a remote MCP server authenticates sandboxed agents' requests. */
export type SandboxMcpAuth = 'oauth' | 'connector' | 'none'

/** A remote MCP server as sandboxed agents see it; tokens never leave the host. */
export interface SandboxMcpServer {
  name: string
  host: string
  auth: SandboxMcpAuth
  state: SandboxMcpState
  /** Why the server is not ok, for the settings page; null when it is. */
  reason: string | null
}

export interface SandboxStatus {
  policy: SandboxPolicy
  token_mode: GitHubTokenMode
  claude_credential: ClaudeCredentialMode
  /** Paths every task hides from sandboxed agents and file tools, besides `hidden_paths`. */
  built_in_hidden: string[]
  mcp_servers: SandboxMcpServer[]
}

/** Shown to the agent when WebFetch asks for a host outside the allowlist. */
export const WEBFETCH_BLOCKED = 'Seti network allowlist'

function hostAndPort(url: string): { host: string; port: string } | null {
  if (!URL.canParse(url)) {
    return null
  }
  const parsed = new URL(url)
  const fallback = parsed.protocol === 'http:' ? '80' : '443'
  return { host: parsed.hostname.toLowerCase().replace(/\.$/, ''), port: parsed.port === '' ? fallback : parsed.port }
}

function entryMatches(entry: string, host: string, port: string): boolean {
  const [pattern = '', entryPort] = entry.split(':')
  if (entryPort !== undefined && entryPort !== port) {
    return false
  }
  return pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern
}

/** Whether a URL's host is on the allowlist, with the wildcard and port rules the sandbox uses. */
export function urlAllowed(url: string, allowed: readonly string[]): boolean {
  const target = hostAndPort(url)
  return target !== null && allowed.some((entry) => entryMatches(entry, target.host, target.port))
}

const VIOLATIONS = /<sandbox_violations>([\s\S]*?)<\/sandbox_violations>/g

/** The accesses the sandbox refused, as Claude Code appends them to a command's output. */
export function sandboxViolations(text: string): string[] {
  return [...text.matchAll(VIOLATIONS)].flatMap((match) =>
    (match[1] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  )
}
