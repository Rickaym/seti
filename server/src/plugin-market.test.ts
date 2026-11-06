import fs from 'node:fs'
import path from 'node:path'
import {
  marketplaceSource,
  pluginId,
  type AuditKind,
  type CatalogPlugin,
  type Marketplace,
  type PluginActionResult,
  type PluginCatalog,
  type PluginPreview,
} from '@seti/shared'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { asAgent } from './access.js'
import { createApp } from './app.js'
import type { HttpError } from './http.js'
import type { PluginCli } from './plugin-cli.js'
import { createPluginMarket, pluginMarket } from './plugin-market.js'
import { auditEvents } from './store/audit.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

/** A fake `claude` on SETI_CLAUDE_BIN that logs its arguments and answers from files here. */
const fake = await vi.hoisted(async () => {
  const fsHoisted = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = fsHoisted.mkdtempSync(nodePath.join(tmpdir(), 'seti-plugin-market-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  const dir = nodePath.join(root, 'fake-claude')
  fsHoisted.mkdirSync(dir, { recursive: true })
  const bin = nodePath.join(dir, 'claude')
  const script = [
    '#!/bin/sh',
    `dir='${dir}'`,
    'printf "%s|" "$@" >> "$dir/calls.log"; echo >> "$dir/calls.log"',
    'case "$*" in',
    '  "plugin list --json") cat "$dir/installed.json" ;;',
    '  "plugin list --available --json") cat "$dir/available.json" ;;',
    '  "plugin marketplace list --json") cat "$dir/marketplaces.json" ;;',
    '  "--plugin-dir "*) printf "x\\n\\nComponent inventory\\n  Skills (1)  greet\\n  Agents (0)\\n" ;;',
    '  *) if [ -f "$dir/fail" ]; then cat "$dir/fail"; exit 1; fi',
    '     printf "%s\\n" \'{"outcome":"ok","message":"Cloning\\nDone"}\' ;;',
    'esac',
  ].join('\n')
  fsHoisted.writeFileSync(bin, `${script}\n`, { mode: 0o755 })
  process.env.SETI_CLAUDE_BIN = bin
  return { root, dir }
})

afterAll(() => {
  fs.rmSync(fake.root, { recursive: true, force: true })
})

const app = createApp()
const BASE = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', 'content-type': 'application/json' }

async function send(headers: Record<string, string>, method: string, url: string, body?: unknown) {
  return app.request(`/api${url}`, {
    method,
    headers: { ...BASE, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function data<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { data: T }).data
}

async function detail(res: Response): Promise<string> {
  return ((await res.json()) as { error: { detail: string } }).error.detail
}

const marketDir = path.join(fake.root, 'market')
const write = (name: string, value: unknown) => {
  fs.writeFileSync(path.join(fake.dir, name), JSON.stringify(value))
}
const changeCalls = () =>
  (fs.existsSync(path.join(fake.dir, 'calls.log')) ? fs.readFileSync(path.join(fake.dir, 'calls.log'), 'utf8') : '')
    .split('\n')
    .filter((line) => line !== '' && !line.includes('list|') && !line.startsWith('--plugin-dir'))
    .map((line) => line.split('|').slice(0, -1))

beforeEach(async () => {
  fs.rmSync(path.join(fake.dir, 'calls.log'), { force: true })
  fs.rmSync(path.join(fake.dir, 'fail'), { force: true })
  fs.mkdirSync(path.join(marketDir, '.claude-plugin'), { recursive: true })
  fs.mkdirSync(path.join(marketDir, 'plugins', 'greeter'), { recursive: true })
  fs.writeFileSync(
    path.join(marketDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'team',
      plugins: [
        { name: 'greeter', description: 'Says hello', source: './plugins/greeter', mcpServers: { hello: {} } },
        { name: 'escape', source: '../../etc' },
        { name: 'installed-one', description: 'Already here', source: './plugins/installed-one' },
      ],
    }),
  )
  write('marketplaces.json', [{ name: 'team', source: 'github', repo: 'acme/team', installLocation: marketDir }])
  write('installed.json', [{ id: 'installed-one@team', version: '2.0.0', scope: 'user', enabled: true }])
  write('available.json', {
    installed: [{ id: 'installed-one@team', version: '2.0.0', scope: 'user', enabled: true }],
    available: [
      { pluginId: 'greeter@team', name: 'greeter', marketplaceName: 'team', source: './plugins/greeter' },
      { pluginId: 'escape@team', name: 'escape', marketplaceName: 'team', source: '../../etc' },
      {
        pluginId: 'datadog@directory',
        name: 'datadog',
        marketplaceName: 'directory',
        description: 'Datadog observability',
        version: '0.7.17',
        source: { source: 'url', url: 'https://github.com/DataDog/claude.git' },
        installCount: 900,
      },
    ],
  })
  await pluginMarket.catalog({ refresh: true })
})

describe('validation', () => {
  it.each(['-rf@team', 'a;b@team', 'a b@team', '$(id)@team', 'greeter', 'greeter@-x', 'a`b`@team'])(
    'refuses the plugin id %j',
    (id) => {
      expect(pluginId.safeParse(id).success).toBe(false)
    },
  )

  it.each(['--upload-pack=touch x', '-x', 'acme/team; rm -rf ~', 'a b', '$(id)', 'x|y', '"quoted"', 'a\nb'])(
    'refuses the marketplace source %j',
    (source) => {
      expect(marketplaceSource.safeParse(source).success).toBe(false)
    },
  )

  it.each(['acme/team', 'https://github.com/acme/team.git', 'git@github.com:acme/team.git', '/srv/market', '~/m'])(
    'accepts the marketplace source %j',
    (source) => {
      expect(marketplaceSource.safeParse(source).success).toBe(true)
    },
  )

  it('answers 400 and never runs the CLI for an unsafe id or source', async () => {
    expect((await send(USER_AUTH, 'POST', '/plugins/installed', { id: '--help@team' })).status).toBe(400)
    expect((await send(USER_AUTH, 'DELETE', `/plugins/installed/${encodeURIComponent('a;b@team')}`)).status).toBe(400)
    const res = await send(USER_AUTH, 'POST', '/plugins/marketplaces', { source: '--upload-pack=touch /tmp/x' })
    expect(res.status).toBe(400)
    expect(await detail(res)).toContain('cannot start with -')
    expect(changeCalls()).toEqual([])
  })
})

describe('catalog and marketplaces', () => {
  it('searches the plugins on offer, installed ones first and marked', async () => {
    const all = await data<PluginCatalog>(await send(USER_AUTH, 'GET', '/plugins/catalog'))
    expect(all.total).toBe(4)
    expect(all.plugins.map((plugin) => [plugin.id, plugin.installed])).toEqual([
      ['installed-one@team', true],
      ['datadog@directory', false],
      ['escape@team', false],
      ['greeter@team', false],
    ])
    expect(all.plugins[0]).toMatchObject({ description: 'Already here', version: '2.0.0' })
    const found = await data<PluginCatalog>(await send(USER_AUTH, 'GET', '/plugins/catalog?q=observability'))
    expect(found.plugins.map((plugin: CatalogPlugin) => plugin.id)).toEqual(['datadog@directory'])
    const team = await data<PluginCatalog>(await send(USER_AUTH, 'GET', '/plugins/catalog?marketplace=team&q=gre'))
    expect(team.plugins.map((plugin) => plugin.id)).toEqual(['greeter@team'])
  })

  it('lists configured marketplaces with plugin counts, then built-in ones', async () => {
    expect(await data<Marketplace[]>(await send(USER_AUTH, 'GET', '/plugins/marketplaces'))).toEqual([
      { name: 'team', source: 'acme/team', plugin_count: 3, built_in: false },
      { name: 'directory', source: 'Built in', plugin_count: 1, built_in: true },
    ])
  })

  it('previews what a plugin brings from its manifest and its folder in the checkout', async () => {
    const greeter = await data<PluginPreview>(
      await send(USER_AUTH, 'GET', '/plugins/catalog/preview?id=greeter%40team'),
    )
    expect(greeter).toMatchObject({ description: 'Says hello', source: './plugins/greeter' })
    expect(greeter.components).toMatchObject({ skills: ['greet'], mcp_servers: ['hello'] })
    const remote = await data<PluginPreview>(
      await send(USER_AUTH, 'GET', '/plugins/catalog/preview?id=datadog%40directory'),
    )
    expect(remote).toMatchObject({ source: 'https://github.com/DataDog/claude.git', components: null })
    const escape = await data<PluginPreview>(await send(USER_AUTH, 'GET', '/plugins/catalog/preview?id=escape%40team'))
    expect(escape.components).toBeNull()
    expect((await send(USER_AUTH, 'GET', '/plugins/catalog/preview?id=nope%40team')).status).toBe(404)
  })
})

describe('changes', () => {
  const latest = async (kind: AuditKind) => auditEvents.latest(kind)

  it('installs at user scope, audits it and reports the last line of the result', async () => {
    const result = await data<PluginActionResult>(
      await send(USER_AUTH, 'POST', '/plugins/installed', { id: 'greeter@team' }),
    )
    expect(result).toEqual({ message: 'Done' })
    expect(changeCalls()).toEqual([['plugin', 'install', '--json', '--scope', 'user', '--', 'greeter@team']])
    expect(await latest('plugin.installed')).toMatchObject({
      actor: 'user',
      subject_type: 'plugin',
      subject_id: 'greeter@team',
      summary: 'Installed Claude Code plugin greeter@team',
      detail: { id: 'greeter@team', scope: 'user', result: 'Done' },
    })
  })

  it('enables, disables, updates and uninstalls in the scope the plugin is installed in, and audits each', async () => {
    write('installed.json', [{ id: 'installed-one@team', version: '2.0.0', scope: 'project', enabled: true }])
    const id = encodeURIComponent('installed-one@team')
    await data(await send(USER_AUTH, 'PATCH', `/plugins/installed/${id}`, { enabled: false }))
    await data(await send(USER_AUTH, 'PATCH', `/plugins/installed/${id}`, { enabled: true }))
    await data(await send(USER_AUTH, 'POST', `/plugins/installed/${id}/update`))
    await data(await send(USER_AUTH, 'DELETE', `/plugins/installed/${id}`))
    const tail = ['--json', '--scope', 'project', '--', 'installed-one@team']
    expect(changeCalls()).toEqual([
      ['plugin', 'disable', ...tail],
      ['plugin', 'enable', ...tail],
      ['plugin', 'update', ...tail],
      ['plugin', 'uninstall', ...tail],
    ])
    const done = {
      'plugin.disabled': 'Disabled',
      'plugin.enabled': 'Enabled',
      'plugin.updated': 'Updated',
      'plugin.uninstalled': 'Uninstalled',
    } as const
    for (const [kind, verb] of Object.entries(done) as [keyof typeof done, string][]) {
      expect(await latest(kind)).toMatchObject({
        subject_id: 'installed-one@team',
        summary: `${verb} Claude Code plugin installed-one@team`,
        detail: { scope: 'project' },
      })
    }
  })

  it('refuses to change a plugin that is not installed, without running the change', async () => {
    const res = await send(USER_AUTH, 'DELETE', `/plugins/installed/${encodeURIComponent('greeter@team')}`)
    expect(res.status).toBe(404)
    expect(changeCalls()).toEqual([])
  })

  it('adds, updates and removes marketplaces and audits each', async () => {
    await data(await send(USER_AUTH, 'POST', '/plugins/marketplaces', { source: 'pbakaus/impeccable' }))
    await data(await send(USER_AUTH, 'POST', '/plugins/marketplaces/team/update'))
    await data(await send(USER_AUTH, 'DELETE', '/plugins/marketplaces/team'))
    expect(changeCalls()).toEqual([
      ['plugin', 'marketplace', 'add', '--json', '--', 'pbakaus/impeccable'],
      ['plugin', 'marketplace', 'update', '--json', '--', 'team'],
      ['plugin', 'marketplace', 'remove', '--json', '--', 'team'],
    ])
    expect(await latest('plugin.marketplace_added')).toMatchObject({ detail: { source: 'pbakaus/impeccable' } })
    expect(await latest('plugin.marketplace_updated')).toMatchObject({ subject_id: 'team' })
    expect(await latest('plugin.marketplace_removed')).toMatchObject({ detail: { name: 'team', source: 'acme/team' } })
    expect((await send(USER_AUTH, 'DELETE', '/plugins/marketplaces/directory')).status).toBe(404)
  })

  it("surfaces the CLI's own failure message", async () => {
    fs.writeFileSync(path.join(fake.dir, 'fail'), '{"outcome":"failed","message":"Plugin \\"nope\\" not found"}\n')
    const res = await send(USER_AUTH, 'POST', '/plugins/installed', { id: 'nope@team' })
    expect(res.status).toBe(400)
    expect(await detail(res)).toBe('Plugin "nope" not found')
  })
})

describe('who may change plugins', () => {
  it('refuses the EA every catalog, marketplace and install route', async () => {
    const id = encodeURIComponent('installed-one@team')
    const routes: [string, string, unknown?][] = [
      ['GET', '/plugins/catalog'],
      ['GET', '/plugins/catalog/preview?id=greeter%40team'],
      ['GET', '/plugins/marketplaces'],
      ['POST', '/plugins/marketplaces', { source: 'acme/other' }],
      ['POST', '/plugins/marketplaces/team/update'],
      ['DELETE', '/plugins/marketplaces/team'],
      ['POST', '/plugins/installed', { id: 'greeter@team' }],
      ['PATCH', `/plugins/installed/${id}`, { enabled: false }],
      ['POST', `/plugins/installed/${id}/update`],
      ['DELETE', `/plugins/installed/${id}`],
    ]
    for (const [method, url, body] of routes) {
      const res = await send(EA_AUTH, method, url, body)
      expect(res.status, `${method} ${url}`).toBe(403)
      expect(await detail(res)).toContain('The EA cannot install, remove or change Claude Code plugins')
    }
    expect(changeCalls()).toEqual([])
    expect((await send(EA_AUTH, 'GET', '/plugins')).status).toBe(200)
  })

  it('refuses an agent calling in with its seti tools', async () => {
    const agent = { id: 'agent-1', title: 'Agent', seti_control: 'full' as const }
    const refusal = (await asAgent(agent, async () => pluginMarket.install('greeter@team')).catch(
      (e: unknown) => e,
    )) as HttpError
    expect(refusal.status).toBe(403)
    expect(refusal.message).toContain('Agents cannot install Claude Code plugins')
    expect(changeCalls()).toEqual([])
  })
})

describe('serialization', () => {
  it('runs one change at a time, in the order they came', async () => {
    const started: string[] = []
    const finish: (() => void)[] = []
    const cli: PluginCli = {
      installed: async () => Promise.resolve([]),
      components: async () => Promise.resolve(null),
      marketplaces: async () => Promise.resolve([]),
      available: async () => Promise.resolve({ installed: [], available: [] }),
      change: async (args) => {
        started.push(args.at(-1) ?? '')
        return new Promise((resolve) => {
          finish.push(() => {
            resolve('ok')
          })
        })
      },
    }
    const market = createPluginMarket({ cli, changed: () => false })
    const first = market.install('a@team')
    const second = market.install('b@team')
    await vi.waitFor(() => {
      expect(started).toEqual(['a@team'])
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(started).toEqual(['a@team'])
    finish[0]?.()
    await first
    await vi.waitFor(() => {
      expect(started).toEqual(['a@team', 'b@team'])
    })
    finish[1]?.()
    await second
  })

  it('keeps the queue going after a change fails', async () => {
    const cli: PluginCli = {
      installed: async () => Promise.resolve([]),
      components: async () => Promise.resolve(null),
      marketplaces: async () => Promise.resolve([]),
      available: async () => Promise.resolve({ installed: [], available: [] }),
      change: vi
        .fn<PluginCli['change']>()
        .mockRejectedValueOnce(Object.assign(new Error('Command failed'), { stderr: 'clone failed' }))
        .mockResolvedValueOnce('Installed'),
    }
    const market = createPluginMarket({ cli, changed: () => false })
    const failed = market.install('a@team').catch((e: unknown) => (e as HttpError).message)
    const next = market.install('b@team')
    expect(await failed).toBe('clone failed')
    expect(await next).toEqual({ message: 'Installed' })
  })
})
