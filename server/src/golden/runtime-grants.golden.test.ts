import { STORED_RUNTIMES, type Task } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { taskConnections } from '../connection-egress.js'
import type * as ConnectionEgress from '../connection-egress.js'
import type * as McpSelection from '../mcp-selection.js'
import { proxyGrant } from '../proxy-grant.js'
import { runtimeCapabilities } from '../runtimes/capabilities.js'
import { adapterFor } from '../runtimes/registry.js'
import type { ConnectionRow } from '../store/connections.js'
import { sandboxEnv } from '../task-sandbox.js'
import { asciiJson } from './json.js'

vi.mock('../connection-egress.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ConnectionEgress>()),
  taskConnections: vi.fn(),
}))
vi.mock('../mcp-selection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof McpSelection>()),
  taskDeniedServers: vi.fn().mockResolvedValue(['claude.ai Gmail', 'srv_off']),
}))
vi.mock('../claude-logins.js', () => ({ hostLoginKey: () => 'host-login' }))
vi.mock('../sandbox-mcp.js', () => ({
  mcpTokens: {},
  mcpTargets: () => ['https://mcp.example.test/mcp'],
  mcpHosts: () => ['mcp.example.test'],
}))

const row = (id: string, env: string, hosts: string[], header: boolean): ConnectionRow => ({
  id,
  name: id,
  kind: 'key',
  env,
  placeholder: `seti-placeholder-${id}`,
  hosts,
  header: header ? { name: 'Authorization', template: 'Bearer {value}' } : null,
  mint: null,
  body: false,
  slots: {},
  mint_error: null,
  mint_checked_at: null,
  created_at: '2026-11-26',
  updated_at: '2026-11-26',
})

const CONNECTIONS = [
  row('stripe', 'STRIPE_KEY', ['api.stripe.com'], true),
  row('openai', 'OPENAI_API_KEY', ['api.openai.com'], true),
  row('docs', 'DOCS_TOKEN', ['*.docs.example.test'], false),
]

const task = { id: 't1', profile_id: 'p1', runtime: 'claude' } as Task

const HOST_ENV = { PATH: '/usr/bin', LANG: 'C.UTF-8', LC_ALL: 'C', GITHUB_TOKEN: 'host-secret' }

/** The environment with the host's user name left out, which differs between machines. */
const portable = (env: Record<string, string>) => ({ ...env, USER: '<user>', LOGNAME: '<user>' })

const placeholders = Object.fromEntries(CONNECTIONS.map((each) => [each.env, each.placeholder]))

/** What each runtime's sandbox starts with, for one set of connections. */
const envs = () => ({
  claude: portable(sandboxEnv(HOST_ENV, '/home/agent', { github: true, connectors: false })),
  claudeWithConnectors: portable(
    sandboxEnv(HOST_ENV, '/home/agent', { github: true, connectors: true, connections: placeholders }),
  ),
  codex: portable(
    sandboxEnv(HOST_ENV, '/home/agent', {
      github: true,
      connectors: true,
      connections: placeholders,
      codex: { modelKey: 'OPENAI_API_KEY' },
    }),
  ),
  codexKeyless: portable(
    sandboxEnv(HOST_ENV, '/home/agent', { github: false, connectors: false, codex: { modelKey: null } }),
  ),
  gemini: portable(
    sandboxEnv(HOST_ENV, '/home/agent', {
      github: true,
      connectors: true,
      connections: { ...placeholders, GEMINI_API: 'seti-placeholder-gemini' },
      gemini: { modelKey: 'GEMINI_API' },
    }),
  ),
  geminiKeyless: portable(
    sandboxEnv(HOST_ENV, '/home/agent', { github: false, connectors: false, gemini: { modelKey: null } }),
  ),
})

/** What each runtime's adapter declares, with functions named rather than shown. */
const declared = () =>
  Object.fromEntries(
    STORED_RUNTIMES.map((runtime) => {
      const { dream, oneShot, tools, ...rest } = adapterFor(runtime).capabilities
      return [
        runtime,
        {
          ...rest,
          dream: dream !== null,
          oneShot: typeof oneShot.open === 'function',
          tools: { ...tools, serverNames: tools.serverNames?.rule ?? null },
        },
      ]
    }),
  )

describe("each runtime's sandbox, grant and capabilities", () => {
  it('stay as recorded', async () => {
    vi.mocked(taskConnections).mockResolvedValue(CONNECTIONS)
    const grants = Object.fromEntries(
      await Promise.all(
        STORED_RUNTIMES.map(async (runtime) => {
          const { grant, denied } = await proxyGrant(task, runtime)
          return [runtime, { grant, denied: [...denied] }] as const
        }),
      ),
    )
    const recorded = { envs: envs(), grants, declared: declared(), capabilities: runtimeCapabilities() }
    await expect(asciiJson(recorded)).toMatchFileSnapshot('./runtime-grants.golden.json')
  })
})
