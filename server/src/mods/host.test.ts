import type { ModDefinition } from '@seti/mod-api'
import { sampleServer } from '@seti/mod-sample/server'
import { sideChatServer } from '@seti/mod-side-chat/server'
import {
  extensionKinds,
  fenceLanguages,
  isPageName,
  kindByName,
  kindViewers,
  MOD_API_VERSION,
  pageExtensions,
  withSetiCommands,
} from '@seti/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { asMod } from '../access.js'
import { refuseAgent, refusePromptAsUser } from '../ea-guard.js'
import { serverApi } from './api.js'
import { ModHost } from './host.js'
import {
  modAuditKinds,
  modCommands,
  modRouteEntries,
  notifyKinds,
  setiCommandRefusal,
  setiCommands,
  slashCommands,
} from './points.js'
import { modStates } from '../store/mods.js'

const snapshot = () => ({
  slash: slashCommands.list(),
  notify: notifyKinds.list(),
  audit: modAuditKinds.list(),
  extensions: extensionKinds.list(),
  kinds: kindViewers.list(),
  pages: pageExtensions.list(),
  fences: fenceLanguages.list(),
  routes: modRouteEntries.list(),
  commands: modCommands.list(),
})

const bundled = (definition: ModDefinition) => new ModHost([{ definition, tier: 'bundled' }])

const manifest = (extra: Record<string, unknown>) => ({
  id: 'probe',
  name: 'Probe',
  version: '1.0.0',
  seti: '^1.0',
  description: 'A mod the tests build',
  ...extra,
})

const PDF_VIEWER = { id: 'pages', title: 'Pages', kinds: ['pdf'], text: false, phone: true }
const PAGE_VIEWER = { id: 'page', title: 'Page', extensions: ['xhtml'], text: true, page: true, phone: true }

const hosts: ModHost[] = []

afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.stopAll()
  }
})

function hostOf(definition: ModDefinition, tier: 'bundled' | 'third-party' = 'bundled'): ModHost {
  const host = new ModHost([{ definition, tier }])
  hosts.push(host)
  return host
}

describe('the mod host', () => {
  it('registers every point the sample declares, and turning it off leaves no trace', async () => {
    const before = snapshot()
    const host = hostOf(sampleServer)
    await host.setEnabled('sample', true)
    expect(slashCommands.has('sample')).toBe(true)
    expect(modCommands.list().filter((entry) => entry.mod === 'sample')).toHaveLength(2)
    expect(notifyKinds.get('sample.hello')).toMatchObject({ mod: 'sample', default: true })
    expect(modAuditKinds.has('mod.sample.counted')).toBe(true)
    expect(kindByName('notes.samplenote')).toBe('text')
    expect(modRouteEntries.list().filter((route) => route.mod === 'sample')).toHaveLength(2)
    expect(withSetiCommands([], setiCommands()).map((command) => command.name)).toEqual(['sample'])
    expect(setiCommandRefusal('/sample hi')).toBe('/sample is a command of the Sample mod and never goes to the agent')
    await host.setEnabled('sample', false)
    expect(snapshot()).toEqual(before)
    expect(kindByName('notes.samplenote')).toBeNull()
    expect(setiCommandRefusal('/sample hi')).toBeNull()
  })

  it("lists the side chat's /btw and refuses it as a prompt only while the mod is on", async () => {
    const before = snapshot()
    const host = hostOf(sideChatServer)
    await host.setEnabled('side-chat', true)
    expect(withSetiCommands([], setiCommands()).map((command) => command.name)).toEqual(['btw'])
    expect(setiCommandRefusal('/btw why?')).toBe('/btw is a command of the Side chat mod and never goes to the agent')
    expect(modRouteEntries.list().map((route) => [route.method, route.path, route.stream])).toEqual([
      ['POST', '/tasks/:task', true],
      ['DELETE', '/tasks/:task/chats/:chat', false],
    ])
    await host.setEnabled('side-chat', false)
    expect(snapshot()).toEqual(before)
    expect(setiCommandRefusal('/btw why?')).toBeNull()
  })

  it('keeps a mod with a broken or unsupported manifest off and says why', () => {
    const host = new ModHost([
      { definition: { manifest: manifest({ id: 'Bad Id' }) }, tier: 'bundled' },
      { definition: { manifest: manifest({ id: 'commands', contributes: { commands: [] } }) }, tier: 'bundled' },
      {
        definition: {
          manifest: manifest({
            id: 'context',
            contributes: { contextProviders: [{ id: 'go', title: 'Go', text: 'Go fast.' }] },
          }),
        },
        tier: 'bundled',
      },
      { definition: { manifest: manifest({ id: 'future', seti: '^2.0' }) }, tier: 'bundled' },
      {
        definition: { manifest: manifest({ id: 'door', contributes: { routes: [{ method: 'GET', path: '/x' }] } }) },
        tier: 'third-party',
      },
      {
        definition: { manifest: manifest({ id: 'pdf', contributes: { fileViewers: [PDF_VIEWER] } }) },
        tier: 'third-party',
      },
      {
        definition: { manifest: manifest({ id: 'pages', contributes: { fileViewers: [PAGE_VIEWER] } }) },
        tier: 'third-party',
      },
      {
        definition: { manifest: manifest({ id: 'fences', contributes: { fenceRenderers: [{ language: 'dot' }] } }) },
        tier: 'third-party',
      },
      {
        definition: { manifest: manifest({ id: 'keys', contributes: { inputHooks: [{ id: 'k', title: 'Keys' }] } }) },
        tier: 'third-party',
      },
    ])
    const problems = host.list().map((mod) => mod.problem)
    expect(problems[0]).toMatch(/^Its manifest is not valid: id: /)
    expect(problems.slice(1)).toEqual([
      null,
      'Context text needs the agents.context capability',
      `It needs mod API ^2.0, and this Seti offers ${MOD_API_VERSION}`,
      'Only mods bundled with Seti may add routes',
      "Only mods bundled with Seti may show Seti's own file kinds, serve pages or switch viewers",
      "Only mods bundled with Seti may show Seti's own file kinds, serve pages or switch viewers",
      'Only mods bundled with Seti may add fenceRenderers',
      'Only mods bundled with Seti may add inputHooks',
    ])
  })

  it("lets a bundled viewer take over Seti's kinds and serve pages, and gives both back when off", async () => {
    const before = snapshot()
    const viewers = {
      manifest: manifest({
        contributes: { fileViewers: [PDF_VIEWER, PAGE_VIEWER], fenceRenderers: [{ language: 'dot' }] },
      }),
    }
    const host = hostOf(viewers)
    await host.setEnabled('probe', true)
    expect(kindViewers.get('pdf')?.viewer).toBe('probe.pages')
    expect(isPageName('a.xhtml')).toBe(true)
    expect(kindByName('a.xhtml')).toBeNull()
    expect(fenceLanguages.get('dot')?.mod).toBe('probe')
    const rival = hostOf({ manifest: manifest({ id: 'rival', contributes: { fileViewers: [PDF_VIEWER] } }) })
    await expect(rival.setEnabled('rival', true)).rejects.toThrow('The file kind viewer pdf is already registered')
    await host.setEnabled('probe', false)
    expect(snapshot()).toEqual(before)
    expect(isPageName('a.xhtml')).toBe(false)
  })

  it('refuses viewers whose declaration does not hold together', () => {
    const problem = (viewer: Record<string, unknown>) =>
      new ModHost([
        { definition: { manifest: manifest({ contributes: { fileViewers: [viewer] } }) }, tier: 'bundled' },
      ]).list()[0]?.problem
    expect(problem({ ...PDF_VIEWER, text: true })).toMatch(/A viewer of text kinds sets text/)
    expect(problem({ ...PDF_VIEWER, kinds: [] })).toMatch(/Name the extensions or kinds it shows/)
    expect(problem({ ...PDF_VIEWER, kinds: ['text'] })).toMatch(/^Its manifest is not valid/)
    expect(problem({ ...PAGE_VIEWER, text: false })).toMatch(/A page viewer shows text files by extension/)
  })

  it('undoes a half-made start, such as a viewer claiming an extension Seti owns', async () => {
    const before = snapshot()
    const claims = {
      manifest: manifest({
        contributes: {
          slashCommands: [{ name: 'probe', description: 'Probes' }],
          fileViewers: [{ id: 'md', title: 'Markdown', extensions: ['md'], text: true, phone: true }],
        },
      }),
    }
    const host = hostOf(claims)
    await expect(host.setEnabled('probe', true)).rejects.toThrow(".md files are Seti's own")
    expect(host.get('probe')?.enabled).toBe(false)
    expect(snapshot()).toEqual(before)
  })

  it('refuses to start a mod whose command for agents or the EA has no handler', async () => {
    const before = snapshot()
    const command = { id: 'go', title: 'Go', for: ['ea'] }
    const host = hostOf({ manifest: manifest({ seti: '^1.3', contributes: { commands: [command] } }) })
    await expect(host.setEnabled('probe', true)).rejects.toThrow('declares the command go')
    expect(snapshot()).toEqual(before)
  })

  it('undoes what a server half registered before it threw', async () => {
    const before = snapshot()
    const throws: ModDefinition = {
      manifest: manifest({ contributes: { routes: [{ method: 'GET', path: '/x' }] } }),
      server: (api) => {
        api.route('GET', '/x', async () => Promise.resolve({ body: 1 }))
        throw new Error('broken on purpose')
      },
    }
    await expect(hostOf(throws).setEnabled('probe', true)).rejects.toThrow('broken on purpose')
    expect(snapshot()).toEqual(before)
  })

  it('holds third-party mods off in safe mode and back on after it', async () => {
    const host = hostOf({ manifest: manifest({}) }, 'third-party')
    await host.setEnabled('probe', true)
    expect(host.get('probe')?.disposers).not.toBeNull()
    await host.setSafeMode(true)
    expect(host.get('probe')?.disposers).toBeNull()
    expect(host.heldBySafeMode(host.list()[0] ?? expect.fail('no mod'))).toBe(true)
    await host.setSafeMode(false)
    expect(host.get('probe')?.disposers).not.toBeNull()
    expect(bundled(sampleServer).safeModeOn()).toBe(false)
  })
})

describe('the mod API', () => {
  const target = (grants: ('storage' | 'tasks.read')[]) =>
    serverApi({
      manifest: {
        ...(bundled(sampleServer).get('sample')?.manifest ?? expect.fail('no sample')),
        id: 'probe',
      },
      grants,
      track: (dispose) => dispose,
    })

  it('refuses what no grant covers', async () => {
    await expect(target([]).storage.set('k', 1)).rejects.toThrow('The mod probe was not granted storage')
    await target(['storage']).storage.set('k', { a: 1 })
    expect(await target(['storage']).storage.get('k')).toEqual({ a: 1 })
    expect(await target(['storage']).storage.keys()).toEqual(['k'])
    await expect(target(['storage']).storage.set('big', 'x'.repeat(70_000))).rejects.toThrow('at most 64 KB')
    await expect(target([]).audit('nope', 'Nope')).rejects.toThrow('nope is not an audit kind the mod probe declared')
    await expect(target([]).fetch('https://example.com')).rejects.toThrow('The mod probe was not granted net.fetch')
  })

  it('runs every call as the mod, which the guards for the user alone refuse', async () => {
    const mod = { id: 'probe', grants: [] }
    await expect(
      asMod(mod, async () => {
        refuseAgent('change the sandbox')
        return Promise.resolve()
      }),
    ).rejects.toThrow('Mods cannot change the sandbox; only the user does that, in Seti')
    await expect(
      asMod(mod, async () => {
        refusePromptAsUser()
        return Promise.resolve()
      }),
    ).rejects.toThrow("Mods cannot write into an agent's conversation")
  })
})

describe('required mods', () => {
  const required = { manifest: manifest({ id: 'core-probe', required: true }) }

  it('start on even when stored off, and refuse to turn off', async () => {
    await modStates.set('core-probe', false)
    const host = hostOf(required)
    expect(host.get('core-probe')?.enabled).toBe(true)
    await host.start()
    expect(host.get('core-probe')).toMatchObject({ enabled: true, problem: null })
    expect(host.get('core-probe')?.disposers).not.toBeNull()
    await expect(host.setEnabled('core-probe', false)).rejects.toThrow('The Probe mod is part of Seti and always on')
    expect(host.get('core-probe')?.disposers).not.toBeNull()
    await host.setEnabled('core-probe', true)
  })

  it('stay off as a third-party mod, which may not be required', () => {
    const mod = hostOf(required, 'third-party').get('core-probe')
    expect(mod).toMatchObject({
      enabled: false,
      problem: 'Only mods bundled with Seti may be required; remove required',
    })
  })
})
