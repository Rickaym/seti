/** The part of the planner request the demo reads. */
interface PlannerRequest {
  message: string
  catalog: { repos: { slug: string }[] }
}

const TITLE_MAX = 60

/** The demo's planner: titles the agent from the message and picks a repo it names, no worktree. */
export async function plannerModel({ message, catalog }: PlannerRequest): Promise<unknown> {
  const lower = message.toLowerCase()
  const firstLine = (message.split('\n')[0] ?? '').trim()
  const named = catalog.repos.filter((repo) => {
    const name = repo.slug.split('/').at(-1) ?? repo.slug
    return lower.includes(repo.slug.toLowerCase()) || lower.includes(name.toLowerCase())
  })
  return Promise.resolve({
    title: firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX - 3).trimEnd()}...` : firstLine,
    repos: named.slice(0, 1).map((repo) => repo.slug),
    worktree: false,
    link_packs: [],
    unlink_packs: [],
    enable_mcp: [],
    disable_mcp: [],
    ssh_hosts: [],
    aws: false,
  })
}
