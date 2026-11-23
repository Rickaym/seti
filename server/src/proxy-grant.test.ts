import type { Task } from '@seti/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { codexKeyConnection } from './codex-key.js'
import type * as ConnectionEgress from './connection-egress.js'
import { taskConnections } from './connection-egress.js'
import type * as McpSelection from './mcp-selection.js'
import { proxyGrant } from './proxy-grant.js'
import type { ConnectionRow } from './store/connections.js'

vi.mock('./connection-egress.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ConnectionEgress>()),
  taskConnections: vi.fn(),
}))
vi.mock('./mcp-selection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof McpSelection>()),
  taskDeniedServers: vi.fn().mockResolvedValue(['srv_off']),
}))

const row = (id: string, env: string, hosts: string[], header = true): ConnectionRow => ({
  id,
  name: id,
  kind: 'key',
  env,
  placeholder: `seti-placeholder-${id}`,
  hosts,
  header: header ? { name: 'Authorization', template: 'Bearer {value}' } : null,
  mint: null,
  slots: {},
  mint_error: null,
  mint_checked_at: null,
  created_at: '2026-11-23',
  updated_at: '2026-11-23',
})

const task = { id: 't1', profile_id: 'p1' } as Task

describe("a Codex agent's grant", () => {
  beforeEach(() => {
    vi.mocked(taskConnections).mockResolvedValue([
      row('stripe', 'STRIPE_KEY', ['api.stripe.com']),
      row('bare', 'OPENAI_BARE', ['api.openai.com'], false),
      row('openai', 'OPENAI_API_KEY', ['*.openai.com']),
    ])
  })

  it("takes the OpenAI key from the agent's connection that sets a header on OpenAI's API", async () => {
    expect((await codexKeyConnection(task))?.env).toBe('OPENAI_API_KEY')
  })

  it('reaches no Anthropic host and carries no Claude login, connector or host sign-in, only its connections', async () => {
    const { grant } = await proxyGrant(task, 'codex')
    expect(grant).toMatchObject({ login: null, anthropic: false, mcp: [], deniedConnectors: [] })
    expect(grant.connections.map((each) => each.env)).toEqual(['STRIPE_KEY', 'OPENAI_BARE', 'OPENAI_API_KEY'])
  })

  it("has no key when no connection sets a header on OpenAI's API", async () => {
    vi.mocked(taskConnections).mockResolvedValue([row('bare', 'OPENAI_BARE', ['api.openai.com'], false)])
    expect(await codexKeyConnection(task)).toBeNull()
  })

  it("leaves a Claude agent's grant reaching Anthropic", async () => {
    const { grant } = await proxyGrant(task)
    expect(grant.anthropic).toBe(true)
  })
})
