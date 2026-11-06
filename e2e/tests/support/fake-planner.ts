/** The part of the server's planner request the fake reads. */
interface PlannerRequest {
  message: string
  catalog: {
    repos: { slug: string }[]
    packs: { name: string }[]
    mcp: { name: string }[]
  }
}

const words = (text: string) => new Set(text.toLowerCase().split(/[^\w./-]+/))

/** The e2e planner: picks what the message names and fails on "planner down"; rules still apply. */
export async function plannerModel(request: PlannerRequest): Promise<unknown> {
  const { message, catalog } = request
  if (message.includes('planner down')) {
    throw new Error('The fake planner is down')
  }
  const said = words(message)
  const lower = message.toLowerCase()
  const named = (name: string) => said.has(name.toLowerCase()) || said.has(name.toLowerCase().split('/').at(-1) ?? '')
  return Promise.resolve({
    title: `Planned: ${message.split('\n')[0] ?? ''}`,
    repos: catalog.repos.filter((repo) => named(repo.slug)).map((repo) => repo.slug),
    worktree: !lower.includes('no worktree'),
    link_packs: catalog.packs.filter((pack) => lower.includes(pack.name.toLowerCase())).map((pack) => pack.name),
    unlink_packs: [],
    enable_mcp: catalog.mcp.filter((server) => lower.includes(`with ${server.name.toLowerCase()}`)).map((s) => s.name),
    disable_mcp: catalog.mcp
      .filter((server) => lower.includes(`without ${server.name.toLowerCase()}`))
      .map((server) => server.name),
    ssh_hosts: lower.includes('server') ? ['server'] : [],
    aws: lower.includes('aws') || lower.includes('cloud'),
  })
}
