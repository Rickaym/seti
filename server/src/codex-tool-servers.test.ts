import type { ProxyGrant } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { codexServersOf } from './codex-tool-servers.js'

const grant = (hosts: string[] = []): ProxyGrant => ({
  login: null,
  anthropic: false,
  connections:
    hosts.length === 0
      ? []
      : [
          {
            id: 'c1',
            name: 'Linear',
            env: 'LINEAR_KEY',
            placeholder: 'seti-placeholder',
            hosts,
            header: { name: 'Authorization', template: 'Bearer {value}' },
            minted: false,
            body: false,
          },
        ],
  mcp: [],
  deniedConnectors: [],
  caHosts: [],
})

const scope = (patch: Partial<Parameters<typeof codexServersOf>[1]> = {}) => ({
  cwd: '/work/app',
  borrowed: {},
  denied: new Set<string>(),
  signedIn: new Set<string>(),
  grant: grant(),
  ...patch,
})

describe("a Codex agent's MCP servers", () => {
  it('takes stdio and streamable HTTP servers configured without a value, by name', () => {
    const host = {
      mcpServers: {
        play: { command: 'npx', args: ['@playwright/mcp'] },
        docs: { type: 'http', url: 'https://docs.example.com/mcp' },
        typed: { type: 'stdio', command: '/usr/bin/srv' },
      },
    }
    expect(codexServersOf(host, scope())).toEqual({
      servers: [
        { name: 'docs', transport: 'http', url: 'https://docs.example.com/mcp' },
        { name: 'play', transport: 'stdio', command: 'npx', args: ['@playwright/mcp'] },
        { name: 'typed', transport: 'stdio', command: '/usr/bin/srv', args: [] },
      ],
      unusable: [],
    })
  })

  it('leaves out servers with a value of their own, and those the agent turned off', () => {
    const host = {
      mcpServers: {
        keyed: { command: 'srv', env: { TOKEN: 'secret-value' } },
        headed: { type: 'http', url: 'https://h.example.com/mcp', headers: { Authorization: 'Bearer x' } },
        query: { type: 'http', url: 'https://q.example.com/mcp?key=x' },
        off: { command: 'srv' },
      },
    }
    const read = codexServersOf(host, scope({ denied: new Set(['off']) }))
    expect(JSON.stringify(read)).not.toContain('secret-value')
    expect(read).toEqual({ servers: [], unusable: [] })
  })

  it('takes a remote server with a header as its URL only, when the proxy signs its host', () => {
    const host = {
      mcpServers: {
        linear: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer x' } },
        oauth: { type: 'http', url: 'https://mcp.oauth.example.com/mcp', headers: { X: 'y' } },
      },
    }
    const read = codexServersOf(host, scope({ grant: grant(['mcp.linear.app']), signedIn: new Set(['oauth']) }))
    expect(read.servers).toEqual([
      { name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp' },
      { name: 'oauth', transport: 'http', url: 'https://mcp.oauth.example.com/mcp' },
    ])
  })

  it('says why it cannot take an SSE server or a name Codex cannot read', () => {
    const host = {
      mcpServers: {
        events: { type: 'sse', url: 'https://sse.example.com/sse' },
        'has space': { command: 'srv' },
      },
    }
    expect(codexServersOf(host, scope()).unusable).toEqual([
      { name: 'events', reason: 'Codex agents cannot use SSE servers.' },
      { name: 'has space', reason: 'Codex takes server names of letters, digits, - and _ only.' },
    ])
  })

  it("gives the folder's own servers over the user's, and the user's over borrowed ones", () => {
    const host = {
      mcpServers: { db: { command: 'user-db' } },
      projects: {
        '/work/app': { mcpServers: { db: { command: 'local-db' } } },
        '/other': { mcpServers: { lent: { command: 'other' } } },
      },
    }
    const borrowed = { lent: { command: 'other' }, db: { command: 'borrowed-db' } }
    expect(codexServersOf(host, scope({ borrowed })).servers).toEqual([
      { name: 'db', transport: 'stdio', command: 'local-db', args: [] },
      { name: 'lent', transport: 'stdio', command: 'other', args: [] },
    ])
  })
})
