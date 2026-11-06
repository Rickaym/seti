import fs from 'node:fs'
import path from 'node:path'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import type { AuditPage, InstalledPlugin, SetiPlugin, Task } from '@seti/shared'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { tasks } from './db.js'
import type { HttpError } from './http.js'
import type { PluginCli } from './plugin-cli.js'
import { readPluginFolder, resolvePluginPath } from './plugin-folder.js'
import { pluginStateFiles, stateWatch } from './plugin-state.js'
import { createPluginCatalog, retireBundledPlugins, sdkPlugins, taskPluginConfigs } from './plugins.js'
import { auditEvents } from './store/audit.js'
import { setiPlugins, taskPluginChoices } from './store/plugins.js'
import { USER_AUTH } from './test-auth.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-plugins-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

/** Sessions whose turns end at once; the options of each session start are kept. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('./fake-sdk.js')
  const fake = new FakeSdk(function* () {
    yield fakeResult()
  })
  return { fake, options: [] as Sdk.Options[] }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof Sdk>()),
  query: (params: Parameters<typeof sdk.fake.query>[0]) => {
    sdk.options.push(params.options ?? {})
    return sdk.fake.query(params)
  },
}))

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

const app = createApp()

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the response data type
async function send<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, data: (text === '' ? null : (JSON.parse(text) as { data: T }).data) as T }
}

function makePlugin(name: string, manifest: unknown = { name, version: '1.0.0', description: `${name} tools` }) {
  const dir = path.join(scratch, 'plugins', name)
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest))
  return dir
}

const rejection = (fn: () => unknown): HttpError => {
  try {
    fn()
  } catch (e) {
    return e as HttpError
  }
  throw new Error('expected a throw')
}

async function pluginKinds(): Promise<string[]> {
  const page = await send<AuditPage>('GET', '/audit?kind=plugin&limit=50')
  return page.data.events.map((e) => e.kind).reverse()
}

const lastOptions = () => sdk.options.at(-1)

describe('plugin folder validation', () => {
  it('expands ~ and requires an absolute path', () => {
    expect(resolvePluginPath('~/tools', '/home/me')).toBe('/home/me/tools')
    expect(resolvePluginPath('/a/b/../c/')).toBe('/a/c')
    expect(rejection(() => resolvePluginPath('tools')).status).toBe(400)
  })

  it('reads name, version and description from plugin.json', () => {
    const dir = makePlugin('reader', { name: 'reader', version: '0.3.0', description: 'Reads', extra: true })
    expect(readPluginFolder(dir)).toEqual({ name: 'reader', version: '0.3.0', description: 'Reads' })
    expect(readPluginFolder(makePlugin('bare', { name: 'bare' }))).toEqual({
      name: 'bare',
      version: null,
      description: '',
    })
  })

  it.each([
    ['a missing folder', () => path.join(scratch, 'nope'), /No folder/],
    ['a file', () => path.join(makePlugin('filey'), '.claude-plugin', 'plugin.json'), /is not a folder/],
    [
      'a folder without a manifest',
      () => {
        const dir = path.join(scratch, 'plain')
        fs.mkdirSync(dir, { recursive: true })
        return dir
      },
      /No \.claude-plugin\/plugin\.json/,
    ],
    [
      'a marketplace folder',
      () => {
        const dir = path.join(scratch, 'market')
        fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true })
        fs.writeFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), '{}')
        return dir
      },
      /marketplace\.json but no/,
    ],
    [
      'invalid JSON',
      () => {
        const dir = makePlugin('broken')
        fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{name')
        return dir
      },
      /not valid JSON/,
    ],
    ['a bad name', () => makePlugin('spaced', { name: 'has space' }), /name must be/],
    ['a missing name', () => makePlugin('nameless', { version: '1' }), /name is required/],
  ])('rejects %s', (_label, folder, message) => {
    const error = rejection(() => readPluginFolder(folder()))
    expect(error.status).toBe(400)
    expect(error.message).toMatch(message)
  })
})

describe('sdkPlugins', () => {
  const plugin = (id: string, enabled = true): SetiPlugin => ({
    id,
    name: id,
    path: `/plugins/${id}`,
    version: null,
    description: '',
    enabled,
    created_at: '2026-01-01',
  })

  it('loads plugins on by default and chosen ones, minus the opted-out ones', () => {
    const plugins = [plugin('a'), plugin('b'), plugin('c', false)]
    expect(sdkPlugins(plugins, { b: false })).toEqual([{ type: 'local', path: '/plugins/a' }])
    expect(sdkPlugins(plugins, {})).toEqual([
      { type: 'local', path: '/plugins/a' },
      { type: 'local', path: '/plugins/b' },
    ])
    expect(sdkPlugins(plugins, { a: false, c: true })).toEqual([
      { type: 'local', path: '/plugins/b' },
      { type: 'local', path: '/plugins/c' },
    ])
  })
})

describe('Seti default plugin routes', () => {
  it('add, list, disable, enable and remove with audit events', async () => {
    const dir = makePlugin('alpha')
    const added = await send<SetiPlugin>('POST', '/plugins/defaults', { path: `${dir}/` })
    expect(added.status).toBe(200)
    expect(added.data).toMatchObject({ name: 'alpha', path: dir, version: '1.0.0', enabled: true })
    const id = added.data.id

    expect((await send('POST', '/plugins/defaults', { path: dir })).status).toBe(409)
    expect(
      (await send('POST', '/plugins/defaults', { path: makePlugin('alpha-copy', { name: 'alpha' }) })).status,
    ).toBe(409)
    expect((await send('POST', '/plugins/defaults', { path: path.join(scratch, 'nope') })).status).toBe(400)
    expect((await send('POST', '/plugins/defaults', { path: 'relative' })).status).toBe(400)
    expect((await send('POST', '/plugins/defaults', {})).status).toBe(400)

    expect((await send<SetiPlugin[]>('GET', '/plugins/defaults')).data.map((p) => p.name)).toEqual(['alpha'])
    expect((await send<SetiPlugin>('PATCH', `/plugins/defaults/${id}`, { enabled: false })).data.enabled).toBe(false)
    await send('PATCH', `/plugins/defaults/${id}`, { enabled: false })
    await send('PATCH', `/plugins/defaults/${id}`, { enabled: true })
    expect((await send('PATCH', '/plugins/defaults/not-a-uuid', { enabled: true })).status).toBe(400)
    expect((await send('DELETE', `/plugins/defaults/${id}`)).status).toBe(204)
    expect((await send('DELETE', `/plugins/defaults/${id}`)).status).toBe(404)

    expect(await pluginKinds()).toEqual([
      'plugin.default_added',
      'plugin.default_disabled',
      'plugin.default_enabled',
      'plugin.default_removed',
    ])
    const page = await send<AuditPage>('GET', '/audit?kind=plugin.default_added&limit=1')
    expect(page.data.events[0]).toMatchObject({
      actor: 'user',
      subject_type: 'plugin',
      subject_id: id,
      summary: `Added Seti default plugin alpha (${dir})`,
      detail: { name: 'alpha', path: dir, version: '1.0.0' },
    })
  })
})

describe('plugins of a task', () => {
  let loaded: SetiPlugin
  let skipped: SetiPlugin
  let off: SetiPlugin

  beforeEach(async () => {
    for (const plugin of await setiPlugins.list()) {
      await setiPlugins.remove(plugin.id)
    }
    loaded = await setiPlugins.create({ name: 'loaded', path: makePlugin('loaded'), version: null, description: '' })
    skipped = await setiPlugins.create({ name: 'skipped', path: makePlugin('skipped'), version: null, description: '' })
    off = await setiPlugins.create({ name: 'off', path: makePlugin('off'), version: null, description: '' })
    await setiPlugins.setEnabled(off.id, false)
  })

  it('passes enabled defaults minus opt-outs to the SDK and audits both lists', async () => {
    const task = await send<Task>('POST', '/tasks', {
      title: 'With plugins',
      prompt: 'Go',
      cwd: scratch,
      disabled_plugin_ids: [skipped.id],
    })
    expect(task.status).toBe(200)
    await vi.waitFor(() => {
      expect(lastOptions()?.plugins).toEqual([{ type: 'local', path: loaded.path }])
    })
    expect(await taskPluginConfigs(task.data.id)).toEqual([{ type: 'local', path: loaded.path }])

    const created = await send<AuditPage>('GET', '/audit?kind=task.created&limit=1')
    expect(created.data.events[0]?.detail).toMatchObject({ plugins: ['loaded'], disabled_plugins: ['skipped'] })

    await setiPlugins.remove(skipped.id)
    expect(await taskPluginChoices.get(task.data.id)).toEqual({})
    await setiPlugins.setEnabled(off.id, true)
    await vi.waitFor(async () => {
      expect((await tasks.get(task.data.id))?.status).toBe('idle')
    })
    const first = sdk.fake.last
    await send('POST', `/tasks/${task.data.id}/messages`, { prompt: 'Again' })
    await vi.waitFor(() => {
      expect(lastOptions()?.plugins).toEqual([
        { type: 'local', path: loaded.path },
        { type: 'local', path: off.path },
      ])
    })
    expect(first?.closed).toBe(true)
    expect(sdk.fake.last?.prompts).toEqual(['Again'])
  })

  it('rejects unknown plugin ids without creating the task', async () => {
    const before = (await send<Task[]>('GET', '/tasks')).data.length
    const res = await send('POST', '/tasks', {
      title: 'Bad',
      prompt: 'Go',
      cwd: scratch,
      disabled_plugin_ids: ['44444444-4444-4444-8444-444444444444'],
    })
    expect(res.status).toBe(400)
    expect((await send<Task[]>('GET', '/tasks')).data).toHaveLength(before)
  })
})

describe('plugin catalog', () => {
  const installed: Omit<InstalledPlugin, 'components'> = {
    id: 'slack@claude-plugins-official',
    name: 'slack',
    marketplace: 'claude-plugins-official',
    version: '1.3.0',
    scope: 'user',
    enabled: true,
  }
  const components = { skills: ['s'], agents: [], commands: [], hooks: [], mcp_servers: [], lsp_servers: [] }

  function fakeCli(fail = false) {
    const cli = {
      installed: vi.fn(async () =>
        fail ? Promise.reject(new Error('claude not found')) : Promise.resolve([installed]),
      ),
      components: vi.fn(async () => Promise.resolve(components)),
    }
    return cli satisfies Pick<PluginCli, 'installed' | 'components'>
  }

  beforeEach(async () => {
    for (const plugin of await setiPlugins.list()) {
      await setiPlugins.remove(plugin.id)
    }
  })

  it('lists defaults and installed plugins with components and caches them until refresh', async () => {
    const dir = makePlugin('listed')
    const plugin = await setiPlugins.create({ name: 'listed', path: dir, version: '1.0.0', description: '' })
    const cli = fakeCli()
    const catalog = createPluginCatalog(cli)

    const listing = await catalog.list()
    expect(listing).toEqual({
      defaults: [{ ...plugin, components, problem: null }],
      installed: [{ ...installed, components }],
      installed_error: null,
    })
    expect(cli.components).toHaveBeenCalledWith({ name: 'listed', path: dir })
    expect(cli.components).toHaveBeenCalledWith({ id: installed.id })

    await catalog.list()
    expect(cli.installed).toHaveBeenCalledTimes(1)
    expect(cli.components).toHaveBeenCalledTimes(2)
    await catalog.list(true)
    expect(cli.installed).toHaveBeenCalledTimes(2)
    expect(cli.components).toHaveBeenCalledTimes(4)
  })

  it('re-reads installed plugins once Claude Code rewrites its plugin files outside Seti', async () => {
    const claudeHome = path.join(scratch, 'outside-claude')
    const [installedFile = '', , settingsFile = ''] = pluginStateFiles(claudeHome)
    fs.mkdirSync(path.dirname(installedFile), { recursive: true })
    fs.writeFileSync(installedFile, '{"version":2,"plugins":{}}')
    const cli = fakeCli()
    const catalog = createPluginCatalog(cli, stateWatch(pluginStateFiles(claudeHome)))

    await catalog.list()
    await catalog.list()
    expect(cli.installed).toHaveBeenCalledTimes(1)

    fs.writeFileSync(installedFile, '{"version":2,"plugins":{"datadog@claude-plugins-official":[]}}')
    await catalog.list()
    expect(cli.installed).toHaveBeenCalledTimes(2)

    fs.writeFileSync(settingsFile, '{"enabledPlugins":{"datadog@claude-plugins-official":false}}')
    await catalog.list()
    await catalog.list()
    expect(cli.installed).toHaveBeenCalledTimes(3)
  })

  it('reports a missing CLI and a moved folder without failing the listing', async () => {
    const dir = makePlugin('moved')
    await setiPlugins.create({ name: 'moved', path: dir, version: null, description: '' })
    fs.rmSync(dir, { recursive: true })
    const cli = fakeCli(true)
    const listing = await createPluginCatalog(cli).list()
    expect(listing.installed).toEqual([])
    expect(listing.installed_error).toBe('claude not found')
    expect(listing.defaults[0]).toMatchObject({ name: 'moved', components: null, problem: `No folder at ${dir}` })
    expect(cli.components).not.toHaveBeenCalled()
  })

  it('serves the listing over the API', async () => {
    const res = await send<{ defaults: unknown[] }>('GET', '/plugins?refresh=2')
    expect(res.status).toBe(400)
  })
})

describe('retired group chat plugin', () => {
  it('removes the seti-team default of older installs and audits it as the system', async () => {
    const old = await setiPlugins.create({
      name: 'seti-team',
      path: path.join(scratch, 'checkout', 'plugins', 'seti-team'),
      version: '0.1.0',
      description: '',
    })
    await retireBundledPlugins()
    expect((await setiPlugins.list()).map((plugin) => plugin.id)).not.toContain(old.id)
    const mine = await setiPlugins.create({
      name: 'seti-team',
      path: path.join(scratch, 'mine', 'seti-team'),
      version: null,
      description: '',
    })
    await retireBundledPlugins()
    expect((await setiPlugins.list()).map((plugin) => plugin.id)).toContain(mine.id)
    await auditEvents.settled()
    expect(await auditEvents.latest('plugin.default_removed')).toMatchObject({ actor: 'system', subject_id: old.id })
  })
})
