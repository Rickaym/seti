import type { APIRequestContext, Page } from '@playwright/test'
import type { AgentPermissions, PermissionPolicy, ReviewCoverage, ReviewTool } from '@seti/shared'
import { apiData, unique } from './fixtures.js'

/** The writing tools of a fictional chat server: three it marks open-world and one it does not. */
const TOOLS: readonly (readonly [string, boolean])[] = [
  ['send_message', true],
  ['schedule_message', true],
  ['complete_file_upload', true],
  ['rename_list', false],
]

export interface ChatServer {
  /** The rule that names the whole server. */
  rule: string
  label: string
  tool: (name: string) => string
}

/** A chat server with a name of its own, so specs that share a Seti never meet. */
export function chatServer(): ChatServer {
  const name = unique('chat').replace(/\W/g, '_')
  const rule = `mcp__${name}`
  const label = (name.charAt(0).toUpperCase() + name.slice(1)).replaceAll('_', ' ')
  return { rule, label, tool: (tool) => `${rule}__${tool}` }
}

const holds = (rules: readonly string[], tool: string) =>
  rules.some((rule) => rule === tool || tool.startsWith(`${rule}__`))

function toolsOf(server: ChatServer, reviewed: readonly string[]): ReviewTool[] {
  return TOOLS.map(([name, outward]) => ({
    rule: server.tool(name),
    name,
    basis: 'annotations',
    outward,
    reviewed: holds(reviewed, server.tool(name)),
  }))
}

const reviewRules = (policy: Pick<PermissionPolicy, 'rules'> & Partial<Pick<AgentPermissions, 'own'>>) =>
  [...policy.rules, ...(policy.own ?? [])].filter((rule) => rule.behavior === 'review').map((rule) => rule.rule)

/** Answers as a Seti that probed the server would, from the real rules at `scope`. */
export async function mockChatServer(page: Page, server: ChatServer, scope = '/permissions'): Promise<void> {
  const path = scope.replaceAll('/', String.raw`\/`)
  await page.route(new RegExp(String.raw`\/api${path}\/rules\/coverage\?`), async (route) => {
    const rule = new URL(route.request().url()).searchParams.get('rule') ?? ''
    const reviewed = reviewRules(await apiData<AgentPermissions>(page.request, scope))
    const coverage: ReviewCoverage = {
      server: server.rule,
      label: server.label,
      tool: rule === server.rule ? null : rule,
      known: true,
      tools: toolsOf(server, reviewed),
    }
    await route.fulfill({ json: { data: coverage, meta: {} } })
  })
  await page.route(new RegExp(String.raw`\/api${path}$`), async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { data: AgentPermissions }
    const all = reviewRules(body.data)
    const own = scope === '/permissions' ? all : reviewRules({ rules: [], own: body.data.own })
    const uncovered = toolsOf(server, all).filter((tool) => tool.outward && !tool.reviewed).length
    const partly = own.some((rule) => rule.startsWith(`${server.rule}__`)) && !all.includes(server.rule)
    const gaps = partly && uncovered > 0 ? [{ server: server.rule, label: server.label, uncovered }] : []
    await route.fulfill({ response, json: { ...body, data: { ...body.data, review_gaps: gaps } } })
  })
}

/** Removes every rule of the server, for every agent. */
export async function removeChatRules(request: APIRequestContext, server: ChatServer): Promise<void> {
  const policy = await apiData<PermissionPolicy>(request, '/permissions')
  for (const rule of policy.rules.filter((r) => r.rule.startsWith(server.rule))) {
    await request.delete(`/api/permissions/rules/${String(rule.id)}`)
  }
}
