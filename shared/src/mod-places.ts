/** Where a view shows one agent, so a runtime the view needs decides whether it shows. */
export const AGENT_VIEW_PLACES: readonly string[] = ['agentTab', 'agentDock']

type Issue = [path: string, message: string]

/** Places that act on one agent, so they need a task argument to name it. */
export function agentPlaceIssues(entry: { for: readonly string[]; needs: readonly string[] }): Issue[] {
  const issues: Issue[] = []
  if (entry.needs.length > 0) {
    issues.push(['needs', 'A command that needs a capability takes a task argument'])
  }
  if (entry.for.includes('agentHeader')) {
    issues.push(['for', "A command in an agent's header takes a task argument"])
  }
  if (entry.for.includes('agentMenu')) {
    issues.push(['for', "A command in an agent's menu takes a task argument"])
  }
  return issues
}
