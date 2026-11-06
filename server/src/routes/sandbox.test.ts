import fs from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_ALLOWED_DOMAINS, type SandboxStatus, type SystemInfo } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { CLAUDE_HOME } from '../config.js'
import { auditEvents } from '../store/audit.js'
import { USER_AUTH } from '../test-auth.js'

const app = createApp()
const LOCAL = { host: '127.0.0.1:3006', ...USER_AUTH, origin: 'http://127.0.0.1:3006' }

async function send(method: string, path: string, body?: unknown) {
  return app.request(`/api${path}`, {
    method,
    headers: { ...LOCAL, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function data<T>(res: Response): Promise<T> {
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

describe('sandbox settings', () => {
  it('starts on with the default allowlist and no GitHub token', async () => {
    const status = await data<SandboxStatus>(await send('GET', '/sandbox'))
    expect(status.policy).toEqual({
      enabled: true,
      allowed_domains: [...DEFAULT_ALLOWED_DOMAINS],
      hidden_paths: [],
      updated_at: null,
    })
    expect(status.token_mode).toBe('none')
    expect(status.claude_credential).toBe('none')
    expect(status.built_in_hidden).toEqual(expect.arrayContaining(['~/.ssh', '~/.config/gh', '~/seti-live']))
    const system = await data<SystemInfo>(await send('GET', '/system'))
    expect(system.sandbox).toEqual({ enabled: true, token_mode: 'none' })
  })

  it('lists the MCP servers sandboxed agents reach, with no token in the response', async () => {
    const access = ['mcp', 'access', 'value'].join('-')
    const login = ['claude', 'login', 'value'].join('-')
    fs.mkdirSync(CLAUDE_HOME, { recursive: true })
    const file = join(CLAUDE_HOME, '.credentials.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        claudeAiOauth: { accessToken: login, scopes: ['user:inference', 'user:mcp_servers'] },
        mcpOAuth: {
          'tracker|1': { serverName: 'tracker', serverUrl: 'https://mcp.tracker.test/mcp', accessToken: access },
        },
      }),
    )
    try {
      const res = await send('GET', '/sandbox')
      const text = await res.clone().text()
      const status = await data<SandboxStatus>(res)
      expect(status.mcp_servers).toEqual([
        { name: 'tracker', host: 'mcp.tracker.test', auth: 'oauth', state: 'ok', reason: null },
        { name: 'claude.ai connectors', host: 'mcp-proxy.anthropic.com', auth: 'connector', state: 'ok', reason: null },
      ])
      expect(text).not.toContain(access)
      expect(text).not.toContain(login)
    } finally {
      fs.rmSync(file)
    }
  })

  it('saves the switch and the lists, and records what changed', async () => {
    const saved = await data<SandboxStatus>(
      await send('PUT', '/sandbox', {
        enabled: false,
        allowed_domains: ['github.com', ' Example.ORG ', 'example.org', '*.corp.test:8443'],
        hidden_paths: ['~/wg0.conf'],
      }),
    )
    expect(saved.policy).toMatchObject({
      enabled: false,
      allowed_domains: ['github.com', 'example.org', '*.corp.test:8443'],
      hidden_paths: ['~/wg0.conf'],
    })
    expect((await data<SystemInfo>(await send('GET', '/system'))).sandbox.enabled).toBe(false)
    expect(await auditEvents.latest('system.sandbox_changed')).toMatchObject({
      actor: 'user',
      summary: 'Task sandbox turned off',
      detail: {
        enabled: false,
        was_enabled: true,
        domains_added: ['example.org', '*.corp.test:8443'],
        hidden_added: ['~/wg0.conf'],
      },
    })
    const removed = (await auditEvents.latest('system.sandbox_changed'))?.detail.domains_removed
    expect(removed).toEqual(expect.arrayContaining(['pypi.org', 'registry.npmjs.org']))
  })

  it('rejects hosts and paths the sandbox cannot use', async () => {
    const base = { enabled: true, allowed_domains: ['github.com'], hidden_paths: [] }
    const bad = [
      { ...base, allowed_domains: ['*'] },
      { ...base, allowed_domains: ['https://github.com'] },
      { ...base, allowed_domains: ['github.com/path'] },
      { ...base, hidden_paths: ['relative/path'] },
      { ...base, hidden_paths: ['~/../etc/passwd'] },
      { enabled: 'yes', allowed_domains: [], hidden_paths: [] },
    ]
    for (const body of bad) {
      expect((await send('PUT', '/sandbox', body)).status).toBe(400)
    }
  })
})
