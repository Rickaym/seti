import { describe, expect, it, vi } from 'vitest'
import { commonConnectors } from './mcp-connector-list.js'
import { configName, createMcpRegistry, toConnector, type Fetch } from './mcp-registry.js'

const remoteEntry = {
  server: {
    name: 'com.example/tracker',
    title: 'Tracker',
    description: 'Issues',
    websiteUrl: 'https://example.com',
    remotes: [
      { type: 'sse', url: 'https://mcp.example.com/sse' },
      {
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        headers: [
          { name: 'Authorization', description: 'Bearer token', isRequired: true, isSecret: true, value: 'Bearer {t}' },
          { name: 'X-Region', description: 'Region', value: 'eu' },
        ],
      },
    ],
  },
  _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
}

const packageEntry = {
  server: {
    name: 'io.github.acme/notes mcp',
    description: 'Notes',
    repository: { url: 'https://github.com/acme/notes' },
    packages: [
      { registryType: 'oci', identifier: 'ghcr.io/acme/notes', version: '1.0.0' },
      {
        registryType: 'pypi',
        identifier: 'acme-notes',
        version: '2.1.0',
        transport: { type: 'stdio' },
        environmentVariables: [{ name: 'NOTES_KEY', isRequired: true, isSecret: true }],
      },
    ],
  },
}

describe('toConnector', () => {
  it('prefers a streamable HTTP remote and names headers without secret values', () => {
    expect(toConnector(remoteEntry)).toMatchObject({
      id: 'com.example/tracker',
      name: 'tracker',
      title: 'Tracker',
      source: 'registry',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      homepage: 'https://example.com',
      fields: [
        { key: 'Authorization', required: true, secret: true, value: '' },
        { key: 'X-Region', required: false, secret: false, value: 'eu' },
      ],
    })
  })

  it('runs a PyPI package with uvx when there is no remote', () => {
    expect(toConnector(packageEntry)).toMatchObject({
      name: 'notes-mcp',
      title: 'io.github.acme/notes mcp',
      transport: 'stdio',
      command: 'uvx',
      args: ['acme-notes==2.1.0'],
      fields: [{ key: 'NOTES_KEY', secret: true, value: '' }],
      homepage: 'https://github.com/acme/notes',
    })
  })

  it('skips deprecated servers and ones Claude Code cannot launch', () => {
    const deprecated = { ...remoteEntry, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deleted' } } }
    expect(toConnector(deprecated)).toBeNull()
    expect(toConnector({ server: { name: 'x/only-docker', packages: [{ registryType: 'oci' }] } })).toBeNull()
    expect(toConnector({ nope: true })).toBeNull()
  })

  it('notes a URL with placeholders', () => {
    const templated = {
      server: { name: 'x/y', remotes: [{ type: 'streamable-http', url: 'https://{tenant}.x.io/mcp' }] },
    }
    expect(toConnector(templated)?.note).toContain('{placeholders}')
  })
})

describe('configName', () => {
  it('keeps the last segment in characters Claude Code accepts', () => {
    expect(configName('io.github.acme/My Server!')).toBe('My-Server')
    expect(configName('///')).toBe('server')
  })
})

describe('createMcpRegistry', () => {
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  it('asks for the latest versions, maps them and caches the page', async () => {
    const fetcher = vi.fn<Fetch>(async () =>
      Promise.resolve(reply({ servers: [remoteEntry, { bad: 1 }], metadata: { nextCursor: 'c2' } })),
    )
    const registry = createMcpRegistry(fetcher, 'https://registry.test', () => 0)
    const page = await registry.search('tracker')
    expect(page.servers.map((s) => s.name)).toEqual(['tracker'])
    expect(page.next_cursor).toBe('c2')
    await registry.search('tracker')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const url = new URL(fetcher.mock.calls[0]?.[0] as URL)
    expect(url.origin + url.pathname).toBe('https://registry.test/v0/servers')
    expect(Object.fromEntries(url.searchParams)).toEqual({ search: 'tracker', version: 'latest', limit: '30' })
  })

  it('reports a failed answer', async () => {
    const registry = createMcpRegistry(async () => Promise.resolve(reply({}, 503)), 'https://registry.test')
    await expect(registry.search('x', 'c1')).rejects.toThrow('The MCP Registry answered 503')
  })
})

describe('commonConnectors', () => {
  it('lists every connector for an empty query and matches all words', () => {
    expect(commonConnectors('').length).toBeGreaterThan(20)
    expect(commonConnectors('google mail').map((c) => c.name)).toEqual([])
    expect(commonConnectors('gmail').map((c) => c.name)).toEqual(['gmail'])
  })

  it('installs Slack as its plugin and gives Google servers an own OAuth app', () => {
    const [slack] = commonConnectors('slack')
    expect(slack?.plugin).toBe('slack@claude-plugins-official')
    expect(commonConnectors('google').every((c) => c.oauth?.own_client === true)).toBe(true)
  })
})
