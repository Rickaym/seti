import type { McpConnector, McpConnectorField } from '@seti/shared'
import { z } from 'zod'
import { MCP_REGISTRY_URL } from './config.js'

const PAGE_SIZE = 30
const TIMEOUT_MS = 10_000
const CACHE_MS = 10 * 60_000
const CACHE_LIMIT = 100
const OFFICIAL = 'io.modelcontextprotocol.registry/official'

const text = z.string().catch('')
const flag = z.boolean().catch(false)

const input = z.looseObject({
  name: text,
  description: text,
  isRequired: flag,
  isSecret: flag,
  value: text,
  default: text,
})

const remote = z.looseObject({ type: text, url: text, headers: z.array(input).catch([]) })

const pkg = z.looseObject({
  registryType: text,
  identifier: text,
  version: text,
  transport: z.looseObject({ type: text }).catch({ type: '' }),
  environmentVariables: z.array(input).catch([]),
})

const entry = z.looseObject({
  server: z.looseObject({
    name: z.string(),
    title: text,
    description: text,
    websiteUrl: text,
    repository: z.looseObject({ url: text }).catch({ url: '' }),
    remotes: z.array(remote).catch([]),
    packages: z.array(pkg).catch([]),
  }),
  _meta: z.record(z.string(), z.looseObject({ status: text })).catch({}),
})

const page = z.object({
  servers: z.array(z.unknown()),
  metadata: z.looseObject({ nextCursor: z.string().optional() }).catch({}),
})

type Entry = z.infer<typeof entry>
type Input = z.infer<typeof input>

/** A header or variable to fill; only a non-secret documented default comes prefilled. */
function field(own: Input): McpConnectorField {
  const preset = own.value === '' ? own.default : own.value
  const value = own.isSecret || preset.includes('{') ? '' : preset
  return { key: own.name, description: own.description, required: own.isRequired, secret: own.isSecret, value }
}

const RUNNERS: Record<string, (id: string, version: string) => { command: string; args: string[] }> = {
  npm: (id, version) => ({ command: 'npx', args: ['-y', version === '' ? id : `${id}@${version}`] }),
  pypi: (id, version) => ({ command: 'uvx', args: [version === '' ? id : `${id}==${version}`] }),
}

type Launch = Pick<McpConnector, 'transport' | 'url' | 'command' | 'args' | 'fields'>

/** How Claude Code reaches it: a streamable HTTP or SSE remote first, else an npm or PyPI package. */
function launchOf(server: Entry['server']): Launch | null {
  const remotes = server.remotes.filter((r) => r.url !== '' && (r.type === 'streamable-http' || r.type === 'sse'))
  const own = remotes.find((r) => r.type === 'streamable-http') ?? remotes[0]
  if (own !== undefined) {
    const transport = own.type === 'sse' ? 'sse' : 'http'
    return { transport, url: own.url, command: '', args: [], fields: own.headers.map(field) }
  }
  for (const p of server.packages) {
    const run = RUNNERS[p.registryType]
    if (run !== undefined && p.identifier !== '' && (p.transport.type === '' || p.transport.type === 'stdio')) {
      return { transport: 'stdio', url: '', ...run(p.identifier, p.version), fields: p.environmentVariables.map(field) }
    }
  }
  return null
}

/** io.github.acme/notion-mcp becomes notion-mcp, the name Claude Code configs accept. */
export function configName(registryName: string): string {
  const last = registryName.split('/').pop() ?? registryName
  const name = last
    .split(/\W+/)
    .filter((part) => part !== '')
    .join('-')
  return (name === '' ? 'server' : name).slice(0, 60)
}

export function toConnector(raw: unknown): McpConnector | null {
  const parsed = entry.safeParse(raw)
  if (!parsed.success) {
    return null
  }
  const { server, _meta } = parsed.data
  const status = _meta[OFFICIAL]?.status ?? 'active'
  const launch = launchOf(server)
  if (status !== 'active' || launch === null) {
    return null
  }
  const homepage = server.websiteUrl === '' ? server.repository.url : server.websiteUrl
  return {
    id: server.name,
    name: configName(server.name),
    title: server.title === '' ? server.name : server.title,
    description: server.description,
    source: 'registry',
    ...launch,
    oauth: null,
    plugin: null,
    homepage: homepage === '' ? null : homepage,
    note: launch.url.includes('{') ? 'Replace the {placeholders} in the URL with your own values.' : '',
  }
}

export interface RegistryPage {
  servers: McpConnector[]
  next_cursor: string | null
}

export type Fetch = typeof fetch

/** Searches the MCP Registry's latest versions, caching each page for a while. */
export function createMcpRegistry(fetcher: Fetch = fetch, base = MCP_REGISTRY_URL, now: () => number = Date.now) {
  const cache = new Map<string, { at: number; page: RegistryPage }>()

  const fetchPage = async (query: string, cursor: string | undefined): Promise<RegistryPage> => {
    const url = new URL('/v0/servers', base)
    url.search = new URLSearchParams({ search: query, version: 'latest', limit: String(PAGE_SIZE) }).toString()
    if (cursor !== undefined) {
      url.searchParams.set('cursor', cursor)
    }
    const res = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } })
    if (!res.ok) {
      throw new Error(`The MCP Registry answered ${String(res.status)}`)
    }
    const body = page.parse(await res.json())
    const servers = body.servers.map(toConnector).filter((c): c is McpConnector => c !== null)
    return { servers, next_cursor: body.metadata.nextCursor ?? null }
  }

  const search = async (query: string, cursor?: string): Promise<RegistryPage> => {
    const key = `${query}\n${cursor ?? ''}`
    const hit = cache.get(key)
    if (hit !== undefined && now() - hit.at < CACHE_MS) {
      return hit.page
    }
    const fresh = await fetchPage(query, cursor)
    if (cache.size >= CACHE_LIMIT) {
      cache.clear()
    }
    cache.set(key, { at: now(), page: fresh })
    return fresh
  }

  return { search }
}

export const mcpRegistry = createMcpRegistry()
