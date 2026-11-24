/** Where a view shows one agent, so a runtime the view needs decides whether it shows. */
export const AGENT_VIEW_PLACES: readonly string[] = ['agentTab', 'agentDock']

/** Places that act on one agent, so they need a task argument to name it. */
export function agentPlaceIssues(entry: { for: readonly string[]; needs: readonly string[] }): [string, string][] {
  return [
    ...(entry.needs.length > 0 ? [['needs', 'A command that needs a capability takes a task argument']] : []),
    ...(entry.for.includes('agentHeader') ? [['for', "A command in an agent's header takes a task argument"]] : []),
    ...(entry.for.includes('agentMenu') ? [['for', "A command in an agent's menu takes a task argument"]] : []),
  ] satisfies [string, string][]
}
