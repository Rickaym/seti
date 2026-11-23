import { VALUE_PLACEHOLDER, type GrantConnection } from '@seti/shared'
import type { EgressPlaceholder } from './egress-placeholders.js'
import type { EgressRule } from './egress-rules.js'

const HTTPS_PORT = 443
const HEADER_UNSAFE = /[\r\n\0]/

/** Each connection's variable set to its placeholder, so SDKs that need one start. */
export const connectionEnv = (connections: readonly GrantConnection[]): Record<string, string> =>
  Object.fromEntries(connections.map((connection) => [connection.env, connection.placeholder]))

/** A connection's value for one request; with `refused`, a minted token renewed in its place. */
export type ConnectionValue = (connection: GrantConnection, refused: string | null) => Promise<string | null>

/** The connections as the egress proxy swaps them, reading each value when a request needs it. */
export const connectionPlaceholders = (
  connections: readonly GrantConnection[],
  value: ConnectionValue,
): EgressPlaceholder[] =>
  connections.map((connection) => ({
    name: connection.name,
    placeholder: connection.placeholder,
    hosts: connection.hosts,
    value: async () => value(connection, null),
  }))

const safe = (value: string | null) => (value === null || value === '' || HEADER_UNSAFE.test(value) ? null : value)

/** The token inside a header value the template made. */
function tokenOf(template: string, value: string): string {
  const [before = '', after = ''] = template.split(VALUE_PLACEHOLDER)
  return value.slice(before.length, value.length - after.length)
}

/** A connection's header as the proxy sets it: its key, or a token it mints and renews. */
export function connectionRule(
  connection: GrantConnection,
  header: NonNullable<GrantConnection['header']>,
  value: ConnectionValue,
): EgressRule {
  const fill = (found: string | null) => {
    const checked = safe(found)
    return checked === null ? null : header.template.replaceAll(VALUE_PLACEHOLDER, checked)
  }
  const base = { hosts: connection.hosts, port: HTTPS_PORT, header: header.name.toLowerCase() }
  if (!connection.minted) {
    return { ...base, value: async () => fill(await value(connection, null)) }
  }
  return {
    ...base,
    value: async () => fill(await value(connection, null)),
    renew: async (_url, refused) => fill(await value(connection, tokenOf(header.template, refused))),
  }
}

/** The headers of the agent's connections, which its proxy applies first. */
export const connectionRules = (connections: readonly GrantConnection[], value: ConnectionValue): EgressRule[] =>
  connections.flatMap((connection) =>
    connection.header === null || connection.hosts.length === 0
      ? []
      : [connectionRule(connection, connection.header, value)],
  )

/** The host's MCP sign-ins as rules, one per host:port target, with the token asked per request. */
export const mcpLoginRules = (targets: readonly string[], token: (url: URL) => Promise<string | null>): EgressRule[] =>
  targets.map((target) => {
    const at = target.lastIndexOf(':')
    return {
      hosts: [target.slice(0, at)],
      port: Number(target.slice(at + 1)),
      header: 'authorization',
      value: async (url) => {
        const found = await token(url)
        return found === null ? null : `Bearer ${found}`
      },
    }
  })
