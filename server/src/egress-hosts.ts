import dns from 'node:dns/promises'
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'
import net from 'node:net'
import { isGitHubOwner, urlAllowed } from '@seti/shared'
import { noValue, type Target, unlessLate } from './egress-answers.js'
import { isAwsHost } from './egress-aws.js'

/** Claude Code talks to this host; the proxy always lets it through with the real credential. */
export const ANTHROPIC_HOST = 'api.anthropic.com'

/** Anthropic's MCP proxy, which serves claude.ai connectors to the account's OAuth token. */
export const MCP_PROXY_HOST = 'mcp-proxy.anthropic.com'

export const ANTHROPIC_HOSTS: readonly string[] = [ANTHROPIC_HOST, MCP_PROXY_HOST]

/** Paths of api.anthropic.com that act for the account, such as the connector list, not inference. */
const ACCOUNT_PATHS = ['/v1/mcp_servers', '/api/oauth/']

/** GitHub hosts whose requests carry the fine-grained token; git uses github.com itself. */
const GITHUB_HOSTS = ['github.com', 'api.github.com', 'uploads.github.com'] as const

/** Hosts the proxy terminates TLS for, to swap placeholders for credentials. */
export const INTERCEPTED_HOSTS = [...ANTHROPIC_HOSTS, ...GITHUB_HOSTS]

const HOP_BY_HOP = [
  'connection',
  'proxy-connection',
  'proxy-authorization',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

export function withoutHopByHop(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const kept: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.includes(name)) {
      kept[name] = value
    }
  }
  return kept
}

export const isGitHub = (host: string) => (GITHUB_HOSTS as readonly string[]).includes(host)

/** API path roots whose next segment is a user or organization. */
const OWNER_ROOTS = ['repos', 'orgs', 'users']

/**
 * The GitHub user or organization a request is about: the first path segment on github.com, as in
 * /owner/repo.git, or the one after /repos, /orgs or /users on the API; null when none is named.
 */
export function githubOwnerOf(host: string, requestPath: string): string | null {
  const [pathname = ''] = requestPath.split('?')
  const segments = pathname.split('/').filter((segment) => segment !== '')
  const [first = '', second] = segments
  if (host === 'github.com') {
    return isGitHubOwner(first) ? first.toLowerCase() : null
  }
  return OWNER_ROOTS.includes(first) && second !== undefined && isGitHubOwner(second) ? second.toLowerCase() : null
}

/**
 * Headers for a request to Anthropic or GitHub: whatever credential the sandbox sent is dropped
 * and the host's real one, if any, put in its place. Null when Claude has no credential.
 */
export function injectCredentials(
  host: string,
  headers: IncomingHttpHeaders,
  token: string | null,
): OutgoingHttpHeaders | null {
  const out = withoutHopByHop(headers)
  delete out.authorization
  if (ANTHROPIC_HOSTS.includes(host)) {
    if (token === null) {
      return null
    }
    delete out['x-api-key']
    out.authorization = `Bearer ${token}`
    return out
  }
  if (token !== null) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
    out.authorization = host === 'github.com' ? `Basic ${basic}` : `Bearer ${token}`
  }
  return out
}

/** The connector a request through Anthropic's MCP proxy is for, from /v1/mcp/{server_id}. */
export function connectorOf(host: string, requestPath: string): string | null {
  if (host !== MCP_PROXY_HOST) {
    return null
  }
  const match = /^\/v1\/mcp\/([^/?#]+)/.exec(requestPath)
  return match?.[1] ?? null
}

/** Loopback, unspecified and link-local addresses, cloud metadata services among them. */
const INTERNAL_ADDRESS = [
  /^127\./,
  /^0\./,
  /^169\.254\./,
  /^::1?$/,
  /^fe[89ab][0-9a-f]:/i,
  /^::ffff:(127|0|169\.254)\./i,
]

/**
 * Resolves a host once and connects to that address, so a name on the allowlist cannot point
 * the proxy at the host's own services; only an address or localhost named outright can.
 */
export async function directAddress(
  host: string,
  port: number,
  lookup: (name: string) => Promise<{ address: string }> = dns.lookup,
): Promise<{ host: string; port: number }> {
  if (host === 'localhost' || net.isIP(host) !== 0) {
    return { host, port }
  }
  const { address } = await lookup(host)
  if (INTERNAL_ADDRESS.some((pattern) => pattern.test(address))) {
    throw new Error(`${host} resolves to ${address}, an address on this machine`)
  }
  return { host: address, port }
}

/** Read for every request, so a token set or rotated in Secrets applies at once. */
export interface EgressCredentials {
  claude: () => Promise<string | null>
  /** The GitHub token for the owner a request names, or for requests that name none. */
  github: (owner: string | null) => Promise<string | null>
  /** The host login's token for claude.ai connectors, when it has their scope. */
  connector: () => Promise<string | null>
}

/**
 * What a model-only proxy applies: the model provider with the agent's Claude credential, and no
 * allowlist, GitHub token, claude.ai connector, cloud or ssh.
 */
export const modelOnly = (claude: () => Promise<string | null>) => ({
  allowed: async (): Promise<readonly string[]> => Promise.resolve([]),
  credentials: {
    claude,
    github: async () => Promise.resolve(null),
    connector: async () => Promise.resolve(null),
  } satisfies EgressCredentials,
  connectorAllowed: () => false,
})

/** The Claude or GitHub credential of a request to a host Seti authenticates itself. */
export async function builtinCredential(
  credentials: EgressCredentials,
  host: string,
  requestPath: string,
): Promise<string | null> {
  const account = host === MCP_PROXY_HOST || ACCOUNT_PATHS.some((prefix) => requestPath.startsWith(prefix))
  if (ANTHROPIC_HOSTS.includes(host)) {
    const connector = account ? await credentials.connector().catch(noValue) : null
    return connector ?? credentials.claude().catch(noValue)
  }
  return credentials.github(githubOwnerOf(host, requestPath)).catch(noValue)
}

/** What decides whether a host no rule covers is open to the agent. */
interface HostChecks {
  allowed: () => Promise<readonly string[]>
  aws?: { enabled: () => Promise<boolean> }
  ssh?: (authority: string) => Promise<boolean>
}

/** An AWS host while the agent has AWS, a first hop of its ssh hosts, or a host on the allowlist. */
export async function openHost(target: Target, { allowed, aws, ssh }: HostChecks): Promise<boolean> {
  if (aws !== undefined && target.port === 443 && isAwsHost(target.host)) {
    return aws.enabled().catch(unlessLate(false))
  }
  if (ssh !== undefined && (await ssh(`${target.host}:${String(target.port)}`).catch(unlessLate(false)))) {
    return true
  }
  return urlAllowed(`https://${target.host}:${String(target.port)}/`, await allowed().catch(unlessLate([])))
}
