import type { CapabilitiesSnapshot, McpServer, ReviewCoverage, ReviewGap, ReviewTool } from '@seti/shared'
import { capabilityCache } from './capabilities.js'
import { serverDisplayName } from './outward-detail.js'
import { mcpNameKind } from './outward.js'
import { namesTool } from './review-hooks.js'

type Candidate = Omit<ReviewTool, 'reviewed'>

/** The rule that names every tool of a server: Claude Code's own spelling of the server's name. */
export function serverRule(name: string): string {
  const plain = name.replace(/[^\w-]/g, '_')
  return `mcp__${name.startsWith('claude.ai ') ? plain.replace(/_+/g, '_').replace(/^_|_$/g, '') : plain}`
}

/** Each server whose tools a probe lists, by its rule; the newest such probe of a server wins. */
export function toolServers(
  snapshots: readonly CapabilitiesSnapshot[] = capabilityCache.all(),
): ReadonlyMap<string, McpServer> {
  const newestFirst = snapshots.toSorted((a, b) => b.probed_at.localeCompare(a.probed_at))
  const found = new Map<string, McpServer>()
  for (const server of newestFirst.flatMap((snapshot) => snapshot.servers)) {
    const rule = serverRule(server.name)
    if (server.tools.length > 0 && !found.has(rule)) {
      found.set(rule, server)
    }
  }
  return found
}

/**
 * The tools of a server that write or send. A server that annotates its tools decides: every tool
 * it does not mark read-only, outward when open-world or when it marks none so. Otherwise the
 * words of each name decide, and a name with no known word is listed as unknown, not outward.
 */
export function writingTools(server: McpServer, rule: string): Candidate[] {
  const annotated = server.tools.some((tool) => tool.read_only || tool.destructive || tool.open_world)
  const marksOpenWorld = server.tools.some((tool) => tool.open_world)
  return server.tools.flatMap((tool): Candidate[] => {
    const named = { rule: `${rule}__${tool.name}`, name: tool.name }
    if (annotated) {
      return tool.read_only ? [] : [{ ...named, basis: 'annotations', outward: tool.open_world || !marksOpenWorld }]
    }
    const kind = mcpNameKind(tool.name)
    return kind === 'read'
      ? []
      : [{ ...named, basis: kind === 'write' ? 'name' : 'unknown', outward: kind === 'write' }]
  })
}

const holds = (rules: readonly string[], tool: string) => rules.some((rule) => namesTool(rule, tool))

const wholeServer = (rules: readonly string[], server: string) =>
  rules.some((rule) => rule === server || rule === `${server}__*`)

/** What the server of `rule` offers to review, given the review rules already in force. */
export function reviewCoverage(
  rule: string,
  reviewRules: readonly string[],
  servers: ReadonlyMap<string, McpServer> = toolServers(),
): ReviewCoverage {
  const [server] = [...servers.keys()]
    .filter((known) => rule === known || rule.startsWith(`${known}__`))
    .toSorted((a, b) => b.length - a.length)
  const found = server === undefined ? undefined : servers.get(server)
  if (server === undefined || found === undefined) {
    const [first = ''] = rule.slice('mcp__'.length).split('__')
    const guess = `mcp__${first}`
    return {
      server: guess,
      label: serverDisplayName(first),
      tool: rule === guess ? null : rule,
      known: false,
      tools: [],
    }
  }
  return {
    server,
    label: serverDisplayName(server.slice('mcp__'.length)),
    tool: rule === server ? null : rule,
    known: true,
    tools: writingTools(found, server).map((tool) => ({ ...tool, reviewed: holds(reviewRules, tool.rule) })),
  }
}

/**
 * The servers `own` review rules cover in part: at least one tool named, no rule for the whole
 * server, and outward tools that none of the rules `inForce` holds.
 */
export function reviewGaps(
  own: readonly string[],
  inForce: readonly string[],
  servers: ReadonlyMap<string, McpServer> = toolServers(),
): ReviewGap[] {
  return [...servers.entries()].flatMap(([server, found]): ReviewGap[] => {
    if (!own.some((rule) => rule.startsWith(`${server}__`)) || wholeServer(inForce, server)) {
      return []
    }
    const uncovered = writingTools(found, server).filter((tool) => tool.outward && !holds(inForce, tool.rule)).length
    return uncovered === 0 ? [] : [{ server, label: serverDisplayName(server.slice('mcp__'.length)), uncovered }]
  })
}
