import { createHash } from 'node:crypto'
import type { Task } from '@seti/shared'
import type { EgressRule } from './egress-rules.js'
import { agentTokenStamp } from './github-token.js'
import { mcpTokens } from './sandbox-mcp.js'
import { profiles } from './store/credentials.js'

const HTTPS_PORT = 443

/**
 * The host's MCP sign-ins as rules: one per host and port, putting the OAuth token of the server
 * a request goes to on it, unless the task turned that server off.
 */
export function mcpLoginRules(denied: ReadonlySet<string>, tokens = mcpTokens): EgressRule[] {
  const targets = new Map<string, { host: string; port: number }>()
  for (const login of tokens.logins()) {
    if (login.url.protocol !== 'https:' || denied.has(login.name)) {
      continue
    }
    const port = login.url.port === '' ? HTTPS_PORT : Number(login.url.port)
    targets.set(`${login.url.hostname}:${String(port)}`, { host: login.url.hostname, port })
  }
  return [...targets.values()].map(({ host, port }) => ({
    hosts: [host],
    port,
    header: 'authorization',
    value: async (url) => {
      const token = await tokens.tokenFor(url, (login) => !denied.has(login.name))
      return token === null ? null : `Bearer ${token}`
    },
  }))
}

/** Changes whenever the task's profile does, so its session restarts with the new one. */
export async function profileStamp(task: Task): Promise<string | null> {
  const profile = await profiles.get(task.profile_id)
  if (profile === undefined) {
    return null
  }
  const github = await agentTokenStamp(profile.id)
  return createHash('sha256')
    .update(JSON.stringify([profile.id, profile.updated_at, github]))
    .digest('hex')
    .slice(0, 16)
}
