import {
  agentAllowed,
  globMatches,
  globProblem,
  hostAllowed,
  manifestProblem,
  MOD_API_VERSION,
  MOD_POINTS,
  modCapability,
  modManifest,
  modNotifyUrl,
  modSwitches,
  thirdPartyHostProblem,
  type ModManifestInput,
} from '@seti/shared'
import { describe, expect, it } from 'vitest'

const base: ModManifestInput = {
  id: 'linear',
  name: 'Linear',
  version: '1.0.0',
  seti: '^1.1',
  description: 'Links agents to Linear issues',
}

const thirdParty = (extra: Partial<ModManifestInput>, bundled: ReadonlySet<string> = new Set(['weather'])) =>
  manifestProblem(modManifest.parse({ ...base, ...extra }), 'third-party', bundled)

const capabilityError = (input: unknown) => {
  const parsed = modCapability.safeParse(input)
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'invalid')
}

describe('the mod API version', () => {
  it('is 1.17.0, which bundled ^1.0 manifests still match', () => {
    expect(MOD_API_VERSION).toBe('1.17.0')
    expect(manifestProblem(modManifest.parse({ ...base, seti: '^1.0' }), 'bundled')).toBeNull()
  })
})

describe('required mods', () => {
  it('are bundled mods alone', () => {
    const required = modManifest.parse({ ...base, required: true })
    expect(required.required).toBe(true)
    expect(modManifest.parse(base).required).toBe(false)
    expect(manifestProblem(required, 'bundled')).toBeNull()
    expect(manifestProblem(required, 'theme')).toBe('Only mods bundled with Seti may be required; remove required')
  })
})

const byName = (a: string, b: string) => a.localeCompare(b)

describe('third-party manifest rules', () => {
  it('takes a manifest that adds nothing Seti cannot run yet', () => {
    expect(thirdParty({})).toBeNull()
  })

  it.each<[string, Partial<ModManifestInput>, string]>([
    [
      'routes',
      { contributes: { routes: [{ method: 'GET', path: '/x' }] } },
      'Only mods bundled with Seti may add routes',
    ],
    [
      'publicPaths',
      { contributes: { publicPaths: [{ path: '/x' }] } },
      'Only mods bundled with Seti may add publicPaths',
    ],
    ['inputHooks', { contributes: { inputHooks: [{ id: 'keys', title: 'Keys' }] } }, 'Only mods bundled with Seti'],
    ['hostProxies', { contributes: { hostProxies: [{ id: 'web', title: 'Web' }] } }, 'Only mods bundled with Seti'],
    ['prDecorators', { contributes: { prDecorators: [{ id: 'pr', title: 'PR' }] } }, 'Only mods bundled with Seti'],
    ['statusMarkers', { contributes: { statusMarkers: [{ id: 'm', title: 'M' }] } }, 'Only mods bundled with Seti'],
    ['agentAccents', { contributes: { agentAccents: [{ id: 'a', title: 'A' }] } }, 'Only mods bundled with Seti'],
    ['defaultEnabled', { defaultEnabled: true }, 'A third-party mod starts off until you turn it on'],
    ['required', { required: true }, 'Only mods bundled with Seti may be required'],
    ['onStartup', { activation: ['onStartup'] }, 'A third-party mod runs only when an event names it'],
    ['the id seti', { id: 'seti' }, 'The id seti is taken by Seti'],
    ['the id ea', { id: 'ea' }, 'The id ea is taken by Seti'],
    ['the id all', { id: 'all' }, 'The id all is taken by Seti'],
    ['a bundled id', { id: 'weather' }, 'The id weather is taken by Seti'],
    ['the name EA', { name: 'EA' }, 'The name EA belongs to Seti'],
    ['the name Executive Assistant', { name: 'executive assistant' }, 'belongs to Seti'],
    ['the name Seti', { name: 'SETI' }, 'The name SETI belongs to Seti'],
    [
      'seti.version',
      { capabilities: [{ name: 'seti.version' }] },
      'Only mods bundled with Seti may ask for seti.version',
    ],
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- a public address the third-party rule must refuse
    ['an IP literal host', { capabilities: [{ name: 'net.fetch', hosts: ['93.184.216.34'] }] }, 'not the address'],
    ['a main that is not .js', { main: 'logic.ts' }, 'main is one .js file'],
    [
      'a key chord',
      {
        main: 'logic.js',
        activation: ['onCommand'],
        contributes: { commands: [{ id: 'go', title: 'Go', for: ['palette'], chord: 'Alt+G' }] },
      },
      'Go binds a key chord, which only mods Seti ships do',
    ],
    [
      'a viewer behind a switch',
      {
        contributes: {
          settings: { show: { type: 'boolean', title: 'Show', default: true } },
          fileViewers: [
            { id: 'k', title: 'K', extensions: ['kk'], text: true, phone: true, entry: 'k.html', setting: 'show' },
          ],
        },
      },
      "Only mods bundled with Seti may show Seti's own file kinds",
    ],
    [
      'a viewer of key files',
      {
        contributes: {
          fileViewers: [{ id: 'k', title: 'Keys', extensions: ['pem'], text: true, phone: true, entry: 'k.html' }],
        },
      },
      '.pem files hold keys or credentials',
    ],
    [
      'a viewer of env files',
      {
        contributes: {
          fileViewers: [{ id: 'e', title: 'Env', extensions: ['env'], text: true, phone: true, entry: 'e.html' }],
        },
      },
      '.env files hold keys or credentials',
    ],
  ])('refuses %s', (_name, extra, problem) => {
    expect(thirdParty(extra)).toContain(problem)
  })

  it('refuses points that stay with bundled mods, and takes every point the design opens', () => {
    const chips = { contributes: { prChips: [{ id: 'size', title: 'Size' }] } }
    expect(thirdParty(chips)).toBe('It adds prChips, which this Seti cannot take from third-party mods yet')
    expect(manifestProblem(modManifest.parse({ ...base, ...chips }), 'bundled')).toBeNull()
    const opened = Object.entries(MOD_POINTS).filter(([, rule]) => rule.thirdParty)
    expect(opened.map(([point]) => point).sort(byName)).toEqual(
      [
        'auditKinds',
        'channelSources',
        'commands',
        'contextProviders',
        'fileViewers',
        'notifications',
        'schedules',
        'settings',
        'slashCommands',
        'statusBar',
        'taskEvents',
        'themes',
        'views',
      ].sort(byName),
    )
    const bundledOnly = Object.entries(MOD_POINTS).filter(([, rule]) => rule.bundledOnly)
    expect(bundledOnly.map(([point]) => point).sort(byName)).toEqual(
      [
        'agentAccents',
        'fenceRenderers',
        'hostProxies',
        'inputHooks',
        'prDecorators',
        'publicPaths',
        'routes',
        'shortcuts',
        'statusMarkers',
        'styles',
      ].sort(byName),
    )
  })

  it('takes webhook sources only, since poller templates need a script Seti ships', () => {
    const source = { id: 'feed', kind: 'poller' as const, title: 'Feed', description: 'A feed' }
    expect(thirdParty({ contributes: { channelSources: [source] } })).toBe(
      'Feed is a poller template, which only mods Seti ships add',
    )
  })

  it('places sandboxed views in a section, an agent tab or the side panel, never in Seti chrome', () => {
    const view = (where: 'section' | 'agentTab' | 'sidePanel' | 'header') => ({
      contributes: { views: [{ id: 'board', title: 'Board', where, phone: true, entry: 'views/board.html' }] },
    })
    expect(thirdParty(view('section'))).toBeNull()
    expect(thirdParty(view('agentTab'))).toBeNull()
    expect(thirdParty(view('sidePanel'))).toBeNull()
    expect(thirdParty(view('header'))).toBe('It adds a view in header, which this Seti cannot place yet')
    expect(manifestProblem(modManifest.parse({ ...base, ...view('agentTab') }), 'bundled')).toContain('agentTab')
  })

  it('keeps ids and names that only resemble reserved ones', () => {
    expect(thirdParty({ id: 'seti-linear', name: 'Seti Linear' })).toBeNull()
  })
})

describe('third-party hosts', () => {
  it.each([
    ['*.co.uk', 'Every site under co.uk belongs to someone else; name the host'],
    ['*.github.io', 'Every site under github.io belongs to someone else; name the host'],
    ['*.vercel.app', 'Every site under vercel.app belongs to someone else'],
    ['*.workers.dev', 'Every site under workers.dev belongs to someone else'],
    ['*.s3.amazonaws.com', 'Every site under s3.amazonaws.com belongs to someone else'],
    ['*.com', 'whole top-level domain'],
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- a public address the third-party rule must refuse
    ['8.8.8.8', 'Name a host, not the address 8.8.8.8'],
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- a private address the rule must refuse
    ['10.0.0.1', 'Name a host, not the address 10.0.0.1'],
    ['localhost', 'never requestable'],
    ['api.internal', 'never requestable'],
  ])('refuses %s', (host, problem) => {
    expect(thirdPartyHostProblem(host)).toContain(problem)
  })

  it.each(['api.linear.app', '*.example.co.uk', '*.example.com', 'octo.github.io', 'api.sink.test'])(
    'takes %s',
    (host) => {
      expect(thirdPartyHostProblem(host)).toBeNull()
    },
  )

  it('refuses a public suffix wildcard in the manifest itself, for every tier', () => {
    const parsed = modManifest.safeParse({ ...base, capabilities: [{ name: 'net.fetch', hosts: ['*.co.uk'] }] })
    expect(parsed.error?.issues[0]?.message).toBe('Every site under co.uk belongs to someone else; name the host')
  })

  it('matches a wildcard to subdomains only, and exact hosts exactly', () => {
    expect(hostAllowed(['*.example.com'], 'api.example.com')).toBe(true)
    expect(hostAllowed(['*.example.com'], 'example.com')).toBe(false)
    expect(hostAllowed(['api.example.com'], 'API.example.com')).toBe(true)
    expect(hostAllowed(['api.example.com'], 'api.example.com.evil.test')).toBe(false)
  })
})

describe('capability scopes', () => {
  it('limits tasks.manage to the actions Seti offers', () => {
    expect(capabilityError({ name: 'tasks.manage', actions: ['rename', 'start'] })).toBeNull()
    expect(capabilityError({ name: 'tasks.manage', actions: ['archive'] })).not.toBeNull()
    expect(capabilityError({ name: 'tasks.manage', actions: ['set_bypass'] })).not.toBeNull()
  })

  it('needs chat.post to say public, direct or both', () => {
    expect(capabilityError({ name: 'chat.post' })).toBe('Say whether it posts in public, directly, or both')
    expect(capabilityError({ name: 'chat.post', direct: true })).toBeNull()
  })

  it('takes agent filters of handles and roles only', () => {
    expect(capabilityError({ name: 'tasks.read', agents: ['builder', 'role:Reviewer'] })).toBeNull()
    expect(capabilityError({ name: 'tasks.read', agents: ['@builder'] })).toContain('Name an agent by handle')
    expect(capabilityError({ name: 'tasks.read', agents: ['role:'] })).toContain('Name an agent by handle')
  })

  it('reads an agent filter by handle and by role, and no filter as every agent', () => {
    expect(agentAllowed(undefined, { handle: 'x', role: null })).toBe(true)
    expect(agentAllowed(['builder'], { handle: 'builder', role: null })).toBe(true)
    expect(agentAllowed(['builder'], { handle: 'reviewer', role: null })).toBe(false)
    expect(agentAllowed(['role:reviewer'], { handle: 'r2', role: 'Reviewer' })).toBe(true)
    expect(agentAllowed(['role:reviewer'], { handle: null, role: null })).toBe(false)
  })

  it.each([
    ['**', 'Name the files'],
    ['**/*', 'Name the files'],
    ['../notes/*.md', 'relative'],
    ['/etc/*', 'relative'],
    ['notes//x.md', 'relative'],
    ['{a,b}.md', 'wildcards * and ?'],
    ['.env*', 'It would cover .env'],
    ['config/.env', 'It would cover config/.env'],
    ['.git/**', 'It would cover .git/config'],
    ['**/*.pem', 'It would cover id.pem'],
    ['certs/*', 'It would cover certs/id.pem'],
  ])('refuses the glob %s', (glob, problem) => {
    expect(globProblem(glob)).toContain(problem)
  })

  it('matches globs by folder, and never into dot names by a wildcard', () => {
    expect(globProblem('notes/**/*.md')).toBeNull()
    expect(globMatches('notes/**/*.md', 'notes/plan.md')).toBe(true)
    expect(globMatches('notes/**/*.md', 'notes/a/b/plan.md')).toBe(true)
    expect(globMatches('notes/**/*.md', 'notes/.hidden/plan.md')).toBe(false)
    expect(globMatches('notes/*.md', 'notes/a/plan.md')).toBe(false)
    expect(globMatches('docs/**', 'docs/a/b.txt')).toBe(true)
    expect(globMatches('docs/**', 'docs/.env')).toBe(false)
    expect(globMatches('src/?.ts', 'src/a.ts')).toBe(true)
  })

  it('keeps notification links on Seti routes', () => {
    expect(modNotifyUrl('/#agent/abc')).toBe('/#agent/abc')
    expect(modNotifyUrl('javascript:alert(1)')).toBe('/')
    expect(modNotifyUrl('https://evil.example/')).toBe('/')
    expect(modNotifyUrl('//evil.example/')).toBe('/')
    expect(modNotifyUrl(undefined)).toBe('/')
  })
})

describe('third-party events', () => {
  const command = { id: 'link', title: 'Link', for: ['palette'] }

  it('refuses an event with nothing declared to fire it', () => {
    expect(thirdParty({ main: 'logic.js', activation: ['onCommand'] })).toBe(
      'onCommand has nothing to run: declare what fires it',
    )
    expect(thirdParty({ main: 'logic.js', activation: ['onTaskEvent'] })).toBe(
      'onTaskEvent has nothing to run: declare what fires it',
    )
  })

  it('holds schedules to 5 minutes through 1 day, and lets views run commands', () => {
    const every = (value: string) =>
      modManifest.safeParse({ ...base, contributes: { schedules: [{ id: 'd', every: value }] } }).success
    expect([every('4m'), every('5m'), every('24h'), every('1d'), every('2d'), every('15 m')]).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
    ])
    const forView = { ...base, contributes: { commands: [{ ...command, for: ['view'] }] } }
    expect(modManifest.safeParse(forView).success).toBe(true)
    const digest = { main: 'logic.js', contributes: { schedules: [{ id: 'digest', every: '15m' }] } }
    expect(thirdParty(digest)).toBe('What it declares needs onSchedule')
    expect(thirdParty({ ...digest, activation: ['onSchedule'] })).toBeNull()
    expect(manifestProblem(modManifest.parse({ ...base, ...digest }), 'bundled')).toContain('logic.js')
  })
})

describe('the styles point', () => {
  const styled = (file: string) => ({ ...base, contributes: { styles: [{ id: 'look', file }] } })

  it('takes a stylesheet beside the manifest from a bundled mod alone', () => {
    const manifest = modManifest.parse(styled('look.css'))
    expect(manifestProblem(manifest, 'bundled')).toBeNull()
    expect(manifestProblem(manifest, 'third-party')).toBe('Only mods bundled with Seti may add styles')
    expect(manifestProblem(manifest, 'theme')).toBe(
      'A theme mod adds themes and nothing else, with no code and no capabilities',
    )
  })

  it.each(['../ui/App.css', 'look.js', 'Look.css', 'dir/look.css'])('refuses the file %s', (file) => {
    expect(modManifest.safeParse(styled(file)).success).toBe(false)
  })
})

describe('viewer switches', () => {
  const viewer = { id: 'pages', title: 'Pages', kinds: ['pdf' as const], text: false, phone: true }
  const switched = (settings: object, extra: object = {}) => ({
    ...base,
    contributes: {
      settings,
      fileViewers: [{ ...viewer, setting: 'pdf', ...extra }],
      fenceRenderers: [{ language: 'mermaid', setting: 'pdf' }],
    },
  })
  const issue = (input: object) => {
    const parsed = modManifest.safeParse(input)
    return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'invalid')
  }

  it('lists the boolean settings that turn viewers and fence renderers on and off', () => {
    const manifest = modManifest.parse(switched({ pdf: { type: 'boolean', title: 'PDF', default: true } }))
    expect(modSwitches(manifest.contributes)).toEqual(['pdf'])
    expect(manifestProblem(manifest, 'bundled')).toBeNull()
    const own = { ...manifest, contributes: { ...manifest.contributes, fenceRenderers: [] } }
    const viewers = own.contributes.fileViewers.map((entry) => ({ ...entry, kinds: [], extensions: ['note'] }))
    expect(manifestProblem({ ...own, contributes: { ...own.contributes, fileViewers: viewers } }, 'third-party')).toBe(
      "Only mods bundled with Seti may show Seti's own file kinds, serve pages or switch viewers",
    )
  })

  it('refuses a switch that names no boolean setting, and a switch on a page viewer', () => {
    expect(issue(switched({}))).toBe('Name a boolean setting it declares')
    expect(issue(switched({ pdf: { type: 'string', title: 'PDF', default: 'on' } }))).toBe(
      'Name a boolean setting it declares',
    )
    const page = { kinds: [], extensions: ['htm'], text: true, page: true }
    expect(issue(switched({ pdf: { type: 'boolean', title: 'PDF', default: true } }, page))).toBe(
      'A page viewer runs while its mod runs',
    )
  })
})
