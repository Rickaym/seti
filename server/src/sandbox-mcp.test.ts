import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SANDBOX_POLICY_DEFAULT } from '@seti/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { createMcpTokens } from './mcp-oauth.js'
import { forgetSandboxSignIns, mcpHosts, mcpTargets, proxiedServers, sandboxMcpServers } from './sandbox-mcp.js'

const ACCESS = ['fake', 'access'].join('-')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-sandbox-mcp-'))
const credentials = path.join(dir, '.credentials.json')
const config = path.join(dir, '.claude.json')

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

fs.writeFileSync(
  credentials,
  JSON.stringify({
    mcpOAuth: {
      'tracker|1': { serverName: 'tracker', serverUrl: 'https://mcp.tracker.test/mcp', accessToken: ACCESS },
      'stale|2': { serverName: 'stale', serverUrl: 'https://stale.test:8443/mcp', accessToken: '', expiresAt: 1 },
    },
  }),
)
fs.writeFileSync(
  config,
  JSON.stringify({
    mcpServers: {
      tracker: { type: 'http', url: 'https://mcp.tracker.test/mcp' },
      docs: { type: 'http', url: 'https://docs.example.com/mcp' },
      open: { type: 'http', url: 'https://github.com/mcp' },
      keyed: { type: 'http', url: 'https://keyed.example.com/mcp', headers: { 'x-key': 'k' } },
      local: { type: 'stdio', command: 'my-mcp' },
    },
  }),
)

const tokens = createMcpTokens(credentials)

describe('sandboxMcpServers', () => {
  it('lists sign-ins, plain remote servers and connectors with their state, and no token', () => {
    const rows = sandboxMcpServers(SANDBOX_POLICY_DEFAULT, tokens, config, () => 'login-token')
    expect(rows.map((row) => [row.name, row.auth, row.state])).toEqual([
      ['docs', 'none', 'refused'],
      ['keyed', 'none', 'refused'],
      ['open', 'none', 'ok'],
      ['stale', 'oauth', 'needs_login'],
      ['tracker', 'oauth', 'ok'],
      ['claude.ai connectors', 'connector', 'ok'],
    ])
    expect(rows.find((row) => row.name === 'docs')?.reason).toContain('not on the allowed hosts list')
    expect(rows.find((row) => row.name === 'stale')?.reason).toContain('on the host')
    expect(JSON.stringify(rows)).not.toContain(ACCESS)
    expect(JSON.stringify(rows)).not.toContain('login-token')
  })

  it('says connectors need the host login when there is no token with their scope', () => {
    const rows = sandboxMcpServers(SANDBOX_POLICY_DEFAULT, tokens, config, () => null)
    expect(rows.at(-1)).toMatchObject({ auth: 'connector', state: 'needs_login' })
  })

  it('gives the proxy each signed-in host with its port, and the CA the host names', () => {
    expect(mcpTargets(tokens)).toEqual(['mcp.tracker.test:443', 'stale.test:8443'])
    expect(mcpTargets(tokens, new Set(['stale']))).toEqual(['mcp.tracker.test:443'])
    expect(mcpHosts(tokens)).toEqual(['mcp.tracker.test', 'stale.test'])
  })
})

describe('proxiedServers', () => {
  it('names the sign-ins that hold a token, less the denied ones', () => {
    expect([...proxiedServers(tokens)]).toEqual(['tracker'])
    expect([...proxiedServers(tokens, new Set(['tracker']))]).toEqual([])
  })
})

describe('forgetSandboxSignIns', () => {
  const claudeDir = path.join(dir, 'sandbox-claude')
  const sandboxCredentials = path.join(claudeDir, '.credentials.json')
  const cache = path.join(claudeDir, 'mcp-needs-auth-cache.json')
  const discovery = { discoveryState: { oauthMetadataFound: true } }
  const read = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'))

  it('drops token-less entries and needs-auth marks of proxied servers only', () => {
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(
      sandboxCredentials,
      JSON.stringify({
        other: true,
        mcpOAuth: {
          'tracker|1': { serverName: 'tracker', accessToken: '', ...discovery },
          'tracker|9': { serverName: 'tracker', refreshToken: 'own-refresh' },
          'stale|2': { serverName: 'stale', accessToken: '', ...discovery },
        },
      }),
      { mode: 0o600 },
    )
    fs.writeFileSync(cache, JSON.stringify({ tracker: { timestamp: 1 }, stale: { timestamp: 2 } }))
    forgetSandboxSignIns(claudeDir, proxiedServers(tokens))
    expect(read(sandboxCredentials)).toEqual({
      other: true,
      mcpOAuth: {
        'tracker|9': { serverName: 'tracker', refreshToken: 'own-refresh' },
        'stale|2': { serverName: 'stale', accessToken: '', ...discovery },
      },
    })
    expect(fs.statSync(sandboxCredentials).mode & 0o777).toBe(0o600)
    expect(read(cache)).toEqual({ stale: { timestamp: 2 } })
    expect(fs.existsSync(path.join(claudeDir, '.storage-write.lock'))).toBe(false)
  })

  it('leaves a sandbox without those files alone', () => {
    const empty = path.join(dir, 'fresh-claude')
    expect(() => {
      forgetSandboxSignIns(empty, new Set(['tracker']))
    }).not.toThrow()
    expect(fs.existsSync(empty)).toBe(false)
  })
})
