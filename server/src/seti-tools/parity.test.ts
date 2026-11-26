import fs from 'node:fs'
import path from 'node:path'
import { AGENT_COLOR_ALIASES, AGENT_COLOR_PRESETS, modManifest, modToolName } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { BUNDLED_MODS, modHost, TEST_MODS } from '../mods/bundled.js'
import { modCommands } from '../mods/points.js'
import { SETI_TOOLS } from './catalog.js'
import { KNOWLEDGE_TOOLS } from './knowledge.js'
import { toolsFor } from './levels.js'
import { modActionTools } from './mod-actions.js'
import { REQUEST_TOOLS, SECRET_TOOLS } from './requests.js'
import { EA_ROUTES } from './route-coverage/ea.js'
import { PRINCIPLES, type Coverage } from './route-coverage/kinds.js'
import { PLATFORM_ROUTES } from './route-coverage/platform.js'
import { SECURITY_ROUTES } from './route-coverage/security.js'
import { TASKS_ROUTES } from './route-coverage/tasks.js'
import { OPINION_TOOLS } from './second-opinion.js'
import { HANDOFF_TOOLS } from './team.js'

const EA_SOURCES = path.resolve(import.meta.dirname, '../../../ea/src/seti_ea')

/** Seti control tools and the ones every agent gets. */
const AGENT_SIDE = [
  ...SETI_TOOLS,
  ...HANDOFF_TOOLS,
  ...REQUEST_TOOLS,
  ...SECRET_TOOLS,
  ...KNOWLEDGE_TOOLS,
  ...OPINION_TOOLS,
]

/** EA tools agents do not get, each with the reason; everything else the EA has, agents have too. */
const NOT_FOR_AGENTS: Record<string, string> = {
  list_my_context_packs: "The EA's own packs; agents change theirs with link_context_pack.",
  change_my_context_packs: "The EA's own packs; agents change theirs with link_context_pack.",
  list_my_channels: "The channels that reach the EA's inbox, which agents do not have.",
  get_ea_settings: "The EA's wake word, how it addresses the user and the language it speaks.",
  update_ea_settings: "The EA's wake word, how it addresses the user and the language it speaks.",
  schedule_followup: 'Check-backs the EA delivers to itself or to the user on a call.',
  list_followups: 'Check-backs the EA delivers to itself or to the user on a call.',
  cancel_followup: 'Check-backs the EA delivers to itself or to the user on a call.',
  watch_task: "Watches feed the EA's inbox.",
  list_watches: "Watches feed the EA's inbox.",
  reply_team_chat: 'Answers a mention of @ea as the EA; agents post with post_team_chat.',
  go_to_sleep: "Ends the EA's listening on a voice call.",
  think: "Hands the EA's own hard question to a slower reasoning model; an agent reasons in its own turn.",
  confirm_asked: "Carries out the user's yes to questions the EA asked; agents ask with request_change.",
  set_agent_access: 'Per-agent access is a security setting only the user changes.',
  set_agent_profile: 'Credentials are a security setting only the user changes.',
  set_memory_cap: 'Memory and CPU caps are a security setting only the user changes.',
  set_mcp_default: 'It turns an MCP server on for every agent, the calling one included.',
  add_mcp_server: "A new server's host joins the sandbox's network allowlist.",
  add_plugin: 'A plugin folder an agent wrote would run its hooks in other agents, unsandboxed ones too.',
  set_plugin_enabled: 'It turns a plugin on for every new agent.',
  run_mod_action: 'Agents get one mod_<mod>_<command> tool per mod command offered to them.',
  answer_question: "Passes on the user's own answer to an agent's question; agents never answer for the user.",
}

/** Agent tools the EA has no tool of the same name for, each with how the EA does the same. */
const ONLY_FOR_AGENTS: Record<string, string> = {
  request_change: 'Agents ask the user for access they lack; the EA speaks for the user, who changes it directly.',
  ask_secret: 'Agents ask the user for a secret; the EA never handles one, and the user enters it in Seti.',
  await_agent: 'The EA waits with watch_task once, which keeps it under its tool cap.',
  agent_activity: 'The EA skims a time window with list_tasks active, which keeps it under its tool cap.',
  read_transcript: "The EA reads a time window with get_task's window, which keeps it under its tool cap.",
  search_knowledge: "The EA searches notes with search_seti's knowledge scope, which keeps it under its tool cap.",
  verify_knowledge: 'A check runs the verify step in a repo, which the EA has no shell for.',
  second_opinion:
    "The EA asks its own reasoning model with think; a second opinion runs in the asking agent's sandbox on " +
    'its credential and bills that agent.',
}

/**
 * Actions neither the EA nor agents get a tool for, each with the reason; both see blocked agents
 * and their reason in their agent lists, so they can remind the user.
 */
const USER_ONLY: Record<string, RegExp> = {
  'Permission requests and rules are security settings; only the user answers or changes them.':
    /permission|approve|allow_tool|deny_tool/,
  'Bypass is a security setting; only the user turns it on or off.': /bypass/,
  'Approved notes reach every agent; only the user approves, rejects or edits them.': /approve|reject|edit_knowledge/,
  "Publishing data outside Seti is the user's call.": /share|publish/,
}

/** Known gaps in the route registry; a PR that closes one lowers it, one that adds one raises it. */
const GAPS_LEFT = 24

const eaSources = () =>
  fs
    .readdirSync(EA_SOURCES)
    .filter((file) => file.endsWith('.py'))
    .map((file) => fs.readFileSync(path.join(EA_SOURCES, file), 'utf8'))

/** Every tool name the EA declares, reading ToolSpec("name", ...) and ToolSpec(CONSTANT, ...). */
function eaToolNames(): string[] {
  const sources = eaSources()
  const constants = new Map(
    sources.flatMap((source) => [...source.matchAll(/^([A-Z_]+) = "(\w+)"$/gm)].map((m) => [m[1], m[2]] as const)),
  )
  return sources.flatMap((source) =>
    [...source.matchAll(/\bToolSpec\(\s*(?:"(\w+)"|([A-Z_]+)\b)/g)].map((m) => {
      const name = m[1] ?? constants.get(m[2] ?? '')
      if (name === undefined) {
        throw new Error(`Cannot read the name of the EA tool declared as ${m[0]}`)
      }
      return name
    }),
  )
}

describe('seti tools', () => {
  it('mirror every EA tool except the ones listed with a reason', () => {
    const ea = eaToolNames()
    const agents = AGENT_SIDE.map((tool) => tool.name).filter((name) => !(name in ONLY_FOR_AGENTS))
    expect(ea.length).toBeGreaterThan(100)
    const byName = (a: string, b: string) => a.localeCompare(b, 'en')
    expect(agents.toSorted(byName)).toEqual(ea.filter((name) => !(name in NOT_FOR_AGENTS)).toSorted(byName))
  })

  it('list no exclusion the EA does not have', () => {
    const ea = new Set(eaToolNames())
    expect(Object.keys(NOT_FOR_AGENTS).filter((name) => !ea.has(name))).toEqual([])
    const agents = new Set(AGENT_SIDE.map((tool) => tool.name))
    expect(Object.keys(ONLY_FOR_AGENTS).filter((name) => ea.has(name) || !agents.has(name))).toEqual([])
  })

  it("leave the actions that stay the user's to the user", () => {
    const names = [...eaToolNames(), ...AGENT_SIDE.map((tool) => tool.name)]
    for (const pattern of Object.values(USER_ONLY)) {
      expect(names.filter((name) => pattern.test(name))).toEqual([])
    }
  })

  it('take the same colour presets and everyday names as the EA', () => {
    const actions = fs.readFileSync(path.join(EA_SOURCES, 'actions.py'), 'utf8')
    const table = (name: string): Record<string, string> => {
      const body = new RegExp(`^${name} = \\{\\n([\\s\\S]*?)^\\}`, 'm').exec(actions)?.[1] ?? ''
      return Object.fromEntries([...body.matchAll(/"([^"]+)": "([^"]+)"/g)].map((m) => [m[1] ?? '', m[2] ?? '']))
    }
    expect(table('AGENT_COLORS')).toEqual(Object.fromEntries(AGENT_COLOR_PRESETS.map((p) => [p.name, p.hex])))
    expect(table('COLOR_ALIASES')).toMatchObject(AGENT_COLOR_ALIASES)
  })

  it('reach every bundled mod command offered to the EA through run_mod_action, and to agents by level', async () => {
    expect(eaToolNames()).toContain('run_mod_action')
    for (const definition of [...BUNDLED_MODS, ...TEST_MODS]) {
      const manifest = modManifest.parse(definition.manifest)
      if (manifest.contributes.commands.length === 0) {
        continue
      }
      const was = modHost.get(manifest.id)?.enabled ?? false
      await modHost.setEnabled(manifest.id, true)
      try {
        const tools = (level: 'self' | 'full') => modActionTools(level).map((tool) => tool.name)
        for (const command of manifest.contributes.commands) {
          const entry = modCommands.get(`${manifest.id}.${command.id}`)
          expect(entry?.command.for.includes('ea') ?? false, `${manifest.id} ${command.id}`).toBe(
            command.for.includes('ea'),
          )
          const name = modToolName(manifest.id, command.id)
          expect(tools('full').includes(name), name).toBe(command.for.includes('agents'))
          expect(tools('self').includes(name), name).toBe(command.for.includes('agents') && command.level === 'self')
        }
      } finally {
        await modHost.setEnabled(manifest.id, was)
      }
    }
  })

  it('have unique names and a description each', () => {
    const names = SETI_TOOLS.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    expect(SETI_TOOLS.filter((tool) => tool.description.trim().length < 20).map((tool) => tool.name)).toEqual([])
  })
})

const ROUTE_TABLES = [EA_ROUTES, TASKS_ROUTES, SECURITY_ROUTES, PLATFORM_ROUTES]
const ROUTES: Readonly<Record<string, Coverage>> = Object.fromEntries(ROUTE_TABLES.flatMap(Object.entries))

/** The method and path of every route the app serves, middleware left out. */
function mountedRoutes(): string[] {
  const keys = createApp()
    .routes.filter((route) => route.method !== 'ALL')
    .map((route) => `${route.method} ${route.path}`)
  return [...new Set(keys)]
}

/** A path the EA's sources call, with the method when the call names one. */
interface EaPath {
  method: string | null
  pattern: RegExp
}

const CALL = /\.(get|post|put|patch|delete)\(\s{0,40}f?"([^"\n]{0,300})"/g
const LITERAL = /f?"([^"\n]*)"/g
const PLACEHOLDER = /\{[^{}]*\}/g

/** A path such as /tasks/{id}/stop or {base}/roots: slashes, words and placeholders only. */
function pathShaped(text: string): boolean {
  const shape = text.replace(PLACEHOLDER, '{}')
  return /^[/{][\w/{}-]*$/.test(shape) && /\/[a-z]/.test(shape) && !/\}[^/]/.test(shape)
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A Python f-string path as a pattern, each {placeholder} standing for one or more path parts. */
const pathPattern = (text: string) => new RegExp(`^${text.split(PLACEHOLDER).map(escaped).join('.+')}$`)

function eaPaths(): EaPath[] {
  return eaSources().flatMap((source) => {
    const calls = [...source.matchAll(CALL)].map((m) => ({ method: (m[1] ?? '').toUpperCase(), text: m[2] ?? '' }))
    const others = [...source.replace(CALL, '').matchAll(LITERAL)].map((m) => ({ method: null, text: m[1] ?? '' }))
    return [...calls, ...others]
      .filter(({ text }) => pathShaped(text))
      .map(({ method, text }) => ({ method, pattern: pathPattern(text) }))
  })
}

/** True when the EA calls the route: its path, with its method where the call names one. */
function eaCalls(paths: readonly EaPath[], route: string): boolean {
  const [method, full = ''] = route.split(' ')
  const sample = full.replace(/^\/api/, '').replace(/:\w+/g, 'x')
  return paths.some((known) => (known.method === null || known.method === method) && known.pattern.test(sample))
}

/** The tool a route ends at, following same routes; null when the chain ends anywhere else. */
function toolOf(route: string, seen: readonly string[] = []): Coverage | null {
  const coverage = ROUTES[route]
  if (coverage === undefined || seen.includes(route)) {
    return null
  }
  return coverage.kind === 'same' ? toolOf(coverage.route, [...seen, route]) : coverage
}

const entriesOf = (kind: Coverage['kind']) => Object.entries(ROUTES).filter(([, coverage]) => coverage.kind === kind)

describe('the route registry', () => {
  it('declares every route the app serves once, and no route it does not serve', () => {
    const routes = mountedRoutes()
    expect(routes.length).toBeGreaterThan(400)
    expect(ROUTE_TABLES.reduce((sum, table) => sum + Object.keys(table).length, 0)).toBe(Object.keys(ROUTES).length)
    expect(
      routes.filter((route) => !(route in ROUTES)),
      'Declare each new route in seti-tools/route-coverage: an EA tool, a seti tool or why not',
    ).toEqual([])
    expect(Object.keys(ROUTES).filter((route) => !routes.includes(route))).toEqual([])
  })

  it('names EA tools that exist and whose sources call the route', () => {
    const tools = new Set(eaToolNames())
    const paths = eaPaths()
    const wrong = entriesOf('ea').filter(
      ([route, coverage]) => coverage.kind === 'ea' && !(tools.has(coverage.tool) && eaCalls(paths, route)),
    )
    expect(wrong.map(([route]) => route)).toEqual([])
  })

  it('names seti tools at a level that has them', () => {
    const wrong = entriesOf('agent').filter(
      ([, coverage]) =>
        coverage.kind === 'agent' && !toolsFor(coverage.level).some((tool) => tool.name === coverage.tool),
    )
    expect(wrong.map(([route]) => route)).toEqual([])
  })

  it('leads every route declared the same as another to a tool', () => {
    const wrong = entriesOf('same').filter(([route]) => {
      const end = toolOf(route)
      return end?.kind !== 'ea' && end?.kind !== 'agent'
    })
    expect(wrong.map(([route]) => route)).toEqual([])
  })

  it('gives every route kept from the EA and agents a principle and a reason', () => {
    const reasons = Object.entries(ROUTES).flatMap(([route, coverage]) =>
      'why' in coverage ? [[route, coverage.why] as const] : [],
    )
    expect(reasons.filter(([, why]) => why.trim().length < 12).map(([route]) => route)).toEqual([])
    const principles = entriesOf('user').filter(([, c]) => c.kind === 'user' && !(c.principle in PRINCIPLES))
    expect(principles.map(([route]) => route)).toEqual([])
  })

  it('holds the known gaps at GAPS_LEFT', () => {
    expect(entriesOf('gap')).toHaveLength(GAPS_LEFT)
  })
})
