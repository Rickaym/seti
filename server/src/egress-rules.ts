import type { OutgoingHttpHeaders } from 'node:http'
import { hostMatches } from '@seti/shared'

/**
 * A header the egress proxy sets on a task's HTTPS requests to some hosts, after dropping
 * whatever the sandbox sent under that name. Profile rules and host MCP sign-ins both take this
 * form, so one place decides which credential goes to which host for which task.
 */
export interface EgressRule {
  /** Exact host names or *.suffix patterns. */
  hosts: readonly string[]
  port: number
  /** Lowercase header name. */
  header: string
  /** The header value for a request, or null to send the request without one. */
  value: (url: URL) => Promise<string | null>
  /** A fresh value after the upstream answered 401 to `refused`; absent when it cannot renew. */
  renew?: (url: URL, refused: string) => Promise<string | null>
}

export const ruleCovers = (rule: EgressRule, host: string, port: number) =>
  rule.port === port && rule.hosts.some((pattern) => hostMatches(pattern, host))

/** Host names the sandbox CA must sign for these rules; *.example.com needs example.com. */
export const ruleCaHosts = (rules: readonly { hosts: readonly string[] }[]) => [
  ...new Set(rules.flatMap((rule) => rule.hosts.map((pattern) => pattern.replace(/^\*\./, '')))),
]

/** A header value a rule set on a request. */
export interface Applied {
  rule: EgressRule
  value: string
}

/** The headers with each matching rule's header set, first rule first, and the values it sent. */
export async function applyRules(
  rules: readonly EgressRule[],
  url: URL | null,
  sent: OutgoingHttpHeaders,
): Promise<{ headers: OutgoingHttpHeaders; applied: Applied[] }> {
  const replaced = new Set(rules.map((rule) => rule.header))
  const headers = Object.fromEntries(Object.entries(sent).filter(([name]) => !replaced.has(name)))
  const applied: Applied[] = []
  for (const rule of rules) {
    const value = url === null || rule.header in headers ? null : await rule.value(url).catch(() => null)
    if (value !== null) {
      headers[rule.header] = value
      applied.push({ rule, value })
    }
  }
  return { headers, applied }
}
