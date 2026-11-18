import type {
  McpServerStatus,
  McpServerStatusConfig,
  SDKControlInitializeResponse,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'
import { summarizeCapabilities, type CapabilitiesSnapshot } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCapabilityCache,
  describeTransport,
  groupCommands,
  probe,
  safeUrl,
  toServer,
  type ProbeSession,
  type ProbeTiming,
} from './capabilities.js'

const FAST: ProbeTiming = { pollMs: 1, pendingCapMs: 200, callTimeoutMs: 200 }

const INIT: SDKControlInitializeResponse = {
  commands: [
    { name: 'mcp', description: 'Manage MCP servers', argumentHint: '', builtin: true },
    { name: 'slack:summarize-channel', description: 'Summarize', argumentHint: '<channel>' },
    { name: 'docs', description: 'Docs', argumentHint: '', aliases: ['anthropic-skills:docs'] },
  ],
  agents: [
    { name: 'posthog:error-analyzer', description: 'Errors' },
    { name: 'Explore', description: 'Search', model: 'inherit' },
  ],
  output_style: 'default',
  available_output_styles: ['default'],
  models: [{ value: 'opus', displayName: 'Opus', description: 'Most capable' }],
  account: { email: 'me@example.com', subscriptionType: 'max' },
}

const server = (name: string, status: McpServerStatus['status'], tools = 0): McpServerStatus => ({
  name,
  status,
  tools: Array.from({ length: tools }, (_, i) => ({ name: `tool${String(i)}` })),
})

function fakeSession(
  statuses: McpServerStatus[][],
  init: Promise<SDKControlInitializeResponse> = Promise.resolve(INIT),
) {
  let call = 0
  const session = {
    initializationResult: vi.fn(async () => init),
    mcpServerStatus: vi.fn(async () => {
      const result = statuses[Math.min(call, statuses.length - 1)] ?? []
      call += 1
      return Promise.resolve(result)
    }),
    close: vi.fn(),
  } satisfies ProbeSession
  return session
}

describe('secret redaction', () => {
  const secret = 'SECRET-VALUE'

  it.each<[McpServerStatusConfig, string, string | null]>([
    [{ command: '/usr/local/bin/npx', args: ['-y', secret], env: { TOKEN: secret } }, 'stdio', 'npx'],
    [{ type: 'stdio', command: 'uvx', env: { API_KEY: secret } }, 'stdio', 'uvx'],
    [
      {
        type: 'http',
        url: `https://user:${secret}@mcp.example.com/mcp?token=${secret}#x`,
        headers: { Authorization: secret },
      },
      'http',
      'https://mcp.example.com/mcp',
    ],
    [
      { type: 'sse', url: 'https://sse.example.com/events', headers: { 'X-Api-Key': secret } },
      'sse',
      'https://sse.example.com/events',
    ],
    [
      { type: 'claudeai-proxy', url: 'https://api.anthropic.com/v1/mcp/abc', id: secret },
      'claudeai-proxy',
      'https://api.anthropic.com/v1/mcp/abc',
    ],
    [{ type: 'sdk', name: 'seti' }, 'sdk', 'seti'],
    [{ type: 'http', url: 'not a url', headers: { Authorization: secret } }, 'http', null],
  ])('%j keeps only transport and target', (config, type, target) => {
    const transport = describeTransport(config)
    expect(transport).toEqual({ type, target })
    expect(JSON.stringify(transport)).not.toContain(secret)
  })

  it('returns null without a config', () => {
    expect(describeTransport(undefined)).toBeNull()
  })

  it('strips credentials and query strings from URLs', () => {
    expect(safeUrl('https://a:b@example.com:8443/p/q?key=1')).toBe('https://example.com:8443/p/q')
  })

  it('scrubs URLs inside server errors and never copies the config', () => {
    const out = toServer({
      name: 'x',
      status: 'failed',
      error: `connect to https://mcp.example.com/mcp?token=${secret} refused`,
      config: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: secret } },
    })
    expect(out.error).toBe('connect to https://mcp.example.com/mcp refused')
    expect(JSON.stringify(out)).not.toContain(secret)
  })

  it('maps tool annotations to flags', () => {
    const out = toServer({
      name: 's',
      status: 'connected',
      tools: [
        { name: 'read', annotations: { readOnly: true, openWorld: true } },
        { name: 'drop', description: 'Drops', annotations: { destructive: true } },
      ],
    })
    expect(out.tools).toEqual([
      { name: 'read', description: '', read_only: true, destructive: false, open_world: true },
      { name: 'drop', description: 'Drops', read_only: false, destructive: true, open_world: false },
    ])
  })
})

describe('groupCommands', () => {
  const commands: SlashCommand[] = [
    { name: 'slack:standup', description: '', argumentHint: '' },
    { name: 'posthog:signals', description: '', argumentHint: '' },
    { name: 'mcp', description: '', argumentHint: '', builtin: true },
    { name: 'slack:channel-digest', description: '', argumentHint: '' },
    { name: 'dataviz', description: '', argumentHint: '' },
    { name: 'clear', description: '', argumentHint: '', builtin: true },
  ]

  it('splits builtins from skills and groups skills by prefix', () => {
    const { skill_groups, builtin_commands } = groupCommands(commands)
    expect(builtin_commands.map((c) => c.name)).toEqual(['clear', 'mcp'])
    expect(skill_groups.map((g) => [g.prefix, g.commands.map((c) => c.name)])).toEqual([
      [null, ['dataviz']],
      ['posthog', ['posthog:signals']],
      ['slack', ['slack:channel-digest', 'slack:standup']],
    ])
  })

  it('summarizes counts by status', async () => {
    const session = fakeSession([[server('a', 'connected', 3), server('b', 'needs-auth')]])
    const snapshot = await probe('/repo', () => session, FAST)
    expect(summarizeCapabilities(snapshot)).toMatchObject({
      servers: { connected: 1, 'needs-auth': 1, failed: 0, pending: 0, disabled: 0 },
      tools: 3,
      skills: 2,
      subagents: 2,
    })
  })
})

describe('probe', () => {
  it('polls until no server is pending and closes the session', async () => {
    const session = fakeSession([
      [server('a', 'pending'), server('b', 'connected')],
      [server('a', 'pending'), server('b', 'connected')],
      [server('a', 'connected', 2), server('b', 'connected')],
    ])
    const snapshot = await probe('/repo', () => session, FAST)
    expect(session.mcpServerStatus).toHaveBeenCalledTimes(3)
    expect(session.close).toHaveBeenCalledOnce()
    expect(snapshot.pending_timed_out).toBe(false)
    expect(snapshot.servers.map((s) => s.status)).toEqual(['connected', 'connected'])
    expect(snapshot.account).toEqual({
      email: 'me@example.com',
      organization: null,
      subscription_type: 'max',
      api_provider: null,
    })
  })

  it('gives up on pending servers at the cap', async () => {
    const session = fakeSession([[server('slow', 'pending')]])
    const snapshot = await probe('/repo', () => session, { ...FAST, pollMs: 5, pendingCapMs: 30 })
    expect(snapshot.pending_timed_out).toBe(true)
    expect(snapshot.servers[0]?.status).toBe('pending')
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('times out a stuck init and still closes', async () => {
    const session = fakeSession([[]], new Promise<SDKControlInitializeResponse>(() => undefined))
    await expect(probe('/repo', () => session, { ...FAST, callTimeoutMs: 20 })).rejects.toThrow(/Timed out/)
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('aborts the idle prompt signal when done', async () => {
    let seen: AbortSignal | undefined
    await probe(
      '/repo',
      (_cwd, signal) => {
        seen = signal
        return fakeSession([[]])
      },
      FAST,
    )
    expect(seen?.aborted).toBe(true)
  })
})

describe('createCapabilityCache', () => {
  it('shares one probe between concurrent callers and caches per cwd', async () => {
    const start = vi.fn(() => fakeSession([[server('a', 'connected')]]))
    const cache = createCapabilityCache(start, FAST)
    const [first, second] = await Promise.all([cache.get('/a'), cache.get('/a')])
    expect(first).toBe(second)
    expect(start).toHaveBeenCalledOnce()
    expect(cache.cached('/a')).toBe(first)
    expect(cache.cached('/b')).toBeUndefined()
    await cache.get('/a')
    expect(start).toHaveBeenCalledOnce()
    await cache.refresh('/a')
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('probes again after a running probe when asked to refresh during it', async () => {
    let release: () => void = () => undefined
    const held = new Promise<SDKControlInitializeResponse>((resolve) => {
      release = () => {
        resolve(INIT)
      }
    })
    const start = vi
      .fn()
      .mockReturnValueOnce(fakeSession([[server('a', 'connected')]], held))
      .mockReturnValue(fakeSession([[server('a', 'connected'), server('added', 'connected')]]))
    const cache = createCapabilityCache(start, FAST)
    const before = cache.get('/a')
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledOnce()
    })
    const [first, second] = [cache.refresh('/a'), cache.refresh('/a')]
    release()
    expect((await before).servers.map((s) => s.name)).toEqual(['a'])
    expect((await first).servers.map((s) => s.name)).toEqual(['a', 'added'])
    expect(await second).toBe(await first)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed probe', async () => {
    const start = vi.fn(() => fakeSession([[]], Promise.reject(new Error('no login'))))
    const cache = createCapabilityCache(start, FAST)
    await expect(cache.get('/a')).rejects.toThrow('no login')
    expect(cache.cached('/a')).toBeUndefined()
    await expect(cache.get('/a')).rejects.toThrow('no login')
    expect(start).toHaveBeenCalledTimes(2)
  })
})

describe('answering without waiting for a probe', () => {
  const HOUR = 60 * 60 * 1000

  afterEach(() => {
    vi.useRealTimers()
  })

  /** A probe per directory that lists one command named after it. */
  const namedProbe = () =>
    vi.fn((cwd: string) =>
      fakeSession(
        [[]],
        Promise.resolve({ ...INIT, commands: [{ name: `from-${cwd.slice(1)}`, description: '', argumentHint: '' }] }),
      ),
    )
  const names = (snapshot: CapabilitiesSnapshot) =>
    snapshot.skill_groups.flatMap((group) => group.commands.map((command) => command.name))

  it('serves an expired snapshot at once and probes again behind it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = namedProbe()
    const cache = createCapabilityCache(start, FAST)
    const first = await cache.get('/repo')
    vi.setSystemTime(Date.now() + 2 * HOUR)

    const stale = await cache.lookup('/repo', [])
    expect(stale).toEqual({ snapshot: first, exact: true, fresh: false })
    await vi.waitFor(() => {
      expect(cache.cached('/repo')).not.toBe(first)
    })
    expect(start).toHaveBeenCalledTimes(2)
    expect(await cache.lookup('/repo', [])).toMatchObject({ exact: true, fresh: true })
    expect(await cache.get('/repo')).toBe(cache.cached('/repo'))
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('stands in the main checkout for a new worktree until the worktree is probed', async () => {
    const start = namedProbe()
    const cache = createCapabilityCache(start, FAST)
    await cache.get('/main')
    await cache.get('/home')

    const nearby = await cache.lookup('/worktree', ['/main', '/home'])
    expect(nearby).toMatchObject({ exact: false, fresh: false })
    expect(names(nearby.snapshot)).toEqual(['from-main'])
    expect(cache.cached('/worktree')).toBeUndefined()

    await vi.waitFor(() => {
      expect(cache.cached('/worktree')).toBeDefined()
    })
    const exact = await cache.lookup('/worktree', ['/main', '/home'])
    expect(exact).toMatchObject({ exact: true, fresh: true })
    expect(names(exact.snapshot)).toEqual(['from-worktree'])
  })

  it('falls back to the home snapshot, then to any snapshot, and waits only when there is none', async () => {
    const start = namedProbe()
    const cache = createCapabilityCache(start, FAST)
    const waited = await cache.lookup('/first', ['/unprobed-main', '/home'])
    expect(waited).toMatchObject({ exact: true, fresh: true })
    expect(names(waited.snapshot)).toEqual(['from-first'])

    const anyDir = await cache.lookup('/second', ['/unprobed-main', '/home'])
    expect(anyDir).toMatchObject({ exact: false, fresh: false })
    expect(names(anyDir.snapshot)).toEqual(['from-first'])

    await cache.get('/home')
    const home = await cache.lookup('/third', ['/unprobed-main', '/home'])
    expect(names(home.snapshot)).toEqual(['from-home'])
  })

  it('does not probe a failing directory again on every lookup', async () => {
    const start = vi.fn((cwd: string) =>
      cwd === '/broken' ? fakeSession([[]], Promise.reject(new Error('no login'))) : fakeSession([[]]),
    )
    const cache = createCapabilityCache(start, FAST)
    await cache.get('/home')
    const failed = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await cache.lookup('/broken', ['/home'])
    await vi.waitFor(() => {
      expect(failed).toHaveBeenCalledWith(expect.stringContaining('capability probe of /broken failed'))
    })
    failed.mockRestore()
    await cache.lookup('/broken', ['/home'])
    await cache.lookup('/broken', ['/home'])
    expect(start.mock.calls.filter(([cwd]) => cwd === '/broken')).toHaveLength(1)
  })
})

describe('warming task directories', () => {
  const SLOW: ProbeTiming = { ...FAST, callTimeoutMs: 5000 }

  /** Probes that stay open until released, counting how many run at once. */
  function gatedProbes() {
    const gates: (() => void)[] = []
    const seen: string[] = []
    let open = 0
    let most = 0
    const start = vi.fn((cwd: string) => {
      seen.push(cwd)
      open += 1
      most = Math.max(most, open)
      const session = fakeSession(
        [[]],
        new Promise<SDKControlInitializeResponse>((resolve) => {
          gates.push(() => {
            resolve(INIT)
          })
        }),
      )
      session.close.mockImplementation(() => {
        open -= 1
      })
      return session
    })
    const releaseAll = async (total: number) => {
      while (seen.length < total || gates.length > 0) {
        gates.shift()?.()
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    return { start, seen, most: () => most, releaseAll }
  }

  it('does nothing until warming starts, then probes two directories at a time', async () => {
    const probes = gatedProbes()
    const cache = createCapabilityCache(probes.start, SLOW)
    cache.prewarm('/early')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(probes.start).not.toHaveBeenCalled()

    cache.startWarming(['/a', '/b', '/c', '/a'])
    cache.prewarm('/d')
    cache.prewarm('/e')
    await vi.waitFor(() => {
      expect(probes.seen).toHaveLength(2)
    })
    await probes.releaseAll(5)
    expect(probes.most()).toBe(2)
    expect(probes.seen.toSorted((a, b) => a.localeCompare(b))).toEqual(['/a', '/b', '/c', '/d', '/e'])
    for (const cwd of probes.seen) {
      expect(cache.cached(cwd)).toBeDefined()
    }
  })

  it('skips directories that already have a fresh snapshot', async () => {
    const start = vi.fn((_cwd: string) => fakeSession([[]]))
    const cache = createCapabilityCache(start, FAST)
    await cache.get('/known')
    cache.startWarming(['/known', '/new'])
    await vi.waitFor(() => {
      expect(cache.cached('/new')).toBeDefined()
    })
    expect(start.mock.calls.map(([cwd]) => cwd)).toEqual(['/known', '/new'])
  })
})
