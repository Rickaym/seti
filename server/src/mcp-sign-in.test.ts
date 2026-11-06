import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mcpSignIn, summarizeCapabilities, type CapabilitiesSnapshot, type McpServer } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import type { McpLogin, McpTokens } from './mcp-oauth.js'
import { clientIdServers, tokenServers, withSignIn } from './mcp-sign-in.js'

const facts = { status: 'connected' as const, transport: 'http', clientId: false, tokenStored: false }

describe('mcpSignIn', () => {
  it('needs a sign-in for a connected client ID web server without a stored token', () => {
    for (const transport of ['http', 'sse']) {
      expect(mcpSignIn({ ...facts, transport, clientId: true })).toEqual({ status: 'needs-auth', sign_in: 'required' })
    }
  })

  it('offers the sign-in whatever Claude Code reports while no token is stored', () => {
    for (const status of ['needs-auth', 'failed', 'pending', 'disabled'] as const) {
      expect(mcpSignIn({ ...facts, status, clientId: true })).toEqual({ status, sign_in: 'required' })
    }
  })

  it('keeps a client ID server with a stored token connected, with a sign-in again', () => {
    expect(mcpSignIn({ ...facts, clientId: true, tokenStored: true })).toEqual({
      status: 'connected',
      sign_in: 'again',
    })
    expect(mcpSignIn({ ...facts, status: 'failed', clientId: true, tokenStored: true })).toEqual({
      status: 'failed',
      sign_in: 'again',
    })
    expect(mcpSignIn({ ...facts, status: 'needs-auth', clientId: true, tokenStored: true })).toEqual({
      status: 'needs-auth',
      sign_in: 'required',
    })
  })

  it('leaves servers without a client ID as Claude Code reports them', () => {
    expect(mcpSignIn(facts)).toEqual({ status: 'connected', sign_in: 'none' })
    expect(mcpSignIn({ ...facts, tokenStored: true })).toEqual({ status: 'connected', sign_in: 'none' })
    expect(mcpSignIn({ ...facts, status: 'failed' })).toEqual({ status: 'failed', sign_in: 'none' })
    for (const transport of ['http', 'sse', 'claudeai-proxy']) {
      expect(mcpSignIn({ ...facts, status: 'needs-auth', transport })).toEqual({
        status: 'needs-auth',
        sign_in: 'required',
      })
    }
  })

  it('leaves stdio servers as they are, client ID or not', () => {
    for (const clientId of [false, true]) {
      expect(mcpSignIn({ ...facts, transport: 'stdio', clientId })).toEqual({ status: 'connected', sign_in: 'none' })
      expect(mcpSignIn({ ...facts, status: 'needs-auth', transport: 'stdio', clientId })).toEqual({
        status: 'needs-auth',
        sign_in: 'none',
      })
    }
    expect(mcpSignIn({ ...facts, status: 'needs-auth', transport: null })).toEqual({
      status: 'needs-auth',
      sign_in: 'none',
    })
  })
})

const withClient = (url: string) => ({ type: 'http', url, oauth: { clientId: 'seti-app', callbackPort: 8765 } })

describe('clientIdServers', () => {
  it('finds client IDs in user, local and project config', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-sign-in-'))
    fs.writeFileSync(
      path.join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { project: withClient('https://project.example/mcp') } }),
    )
    const host = {
      mcpServers: {
        user: withClient('https://user.example/mcp'),
        plain: { type: 'http', url: 'https://plain.example/mcp' },
        blank: { type: 'http', url: 'https://blank.example/mcp', oauth: { clientId: '' } },
      },
      projects: {
        [cwd]: { mcpServers: { local: withClient('https://local.example/mcp') } },
        '/elsewhere': { mcpServers: { other: withClient('https://other.example/mcp') } },
      },
    }
    expect([...clientIdServers(cwd, host)].toSorted((a, b) => a.localeCompare(b, 'en'))).toEqual([
      'local',
      'project',
      'user',
    ])
    fs.rmSync(cwd, { recursive: true, force: true })
  })
})

const login = (name: string, tokens: Partial<McpLogin>): McpLogin => ({
  key: `${name}|1`,
  name,
  url: new URL(`https://${name}.example/mcp`),
  accessToken: undefined,
  refreshToken: undefined,
  expiresAt: undefined,
  clientId: 'seti-app',
  clientSecret: undefined,
  authorizationServer: undefined,
  metadataUrl: undefined,
  ...tokens,
})

describe('tokenServers', () => {
  it('counts a login only when it holds an access or refresh token', () => {
    const tokens: McpTokens = {
      logins: () => [
        login('access', { accessToken: 'a' }),
        login('refresh', { refreshToken: 'r' }),
        login('registered', {}),
      ],
      tokenFor: async () => Promise.resolve(null),
      state: () => 'ok',
    }
    expect([...tokenServers(tokens)].toSorted((a, b) => a.localeCompare(b, 'en'))).toEqual(['access', 'refresh'])
  })
})

const server = (name: string, type: 'http' | 'stdio'): McpServer => ({
  name,
  status: 'connected',
  scope: 'user',
  source: null,
  transport: { type, target: type === 'http' ? `https://${name}.example/mcp` : name },
  connector_id: null,
  server_version: null,
  error: null,
  tools: [],
  sign_in: 'none',
})

describe('withSignIn', () => {
  it('serves client ID servers without a token as needing a sign-in, counted in the summary', () => {
    const snapshot: CapabilitiesSnapshot = {
      cwd: '/work',
      probed_at: '2026-10-04T00:00:00.000Z',
      duration_ms: 1,
      pending_timed_out: false,
      account: { email: null, organization: null, subscription_type: null, api_provider: null },
      servers: [server('fresh', 'http'), server('signed', 'http'), server('plain', 'http'), server('local', 'stdio')],
      skill_groups: [],
      builtin_commands: [],
      subagents: [],
      models: [],
    }
    const served = withSignIn(snapshot, new Set(['fresh', 'signed', 'local']), new Set(['signed']))
    expect(served.servers.map((s) => [s.name, s.status, s.sign_in])).toEqual([
      ['fresh', 'needs-auth', 'required'],
      ['signed', 'connected', 'again'],
      ['plain', 'connected', 'none'],
      ['local', 'connected', 'none'],
    ])
    expect(snapshot.servers[0]?.status).toBe('connected')
    expect(summarizeCapabilities(served).servers).toMatchObject({ connected: 3, 'needs-auth': 1 })
  })
})
