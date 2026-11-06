import fs from 'node:fs'
import path from 'node:path'
import { AGENT_COLOR_ALIASES, AGENT_COLOR_PRESETS, modManifest, modToolName } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { SETI_TOOLS } from './catalog.js'
import { modActionTools } from './mod-actions.js'
import { REQUEST_TOOLS } from './requests.js'
import { HANDOFF_TOOLS } from './team.js'
import { BUNDLED_MODS, modHost, TEST_MODS } from '../mods/bundled.js'
import { modCommands } from '../mods/points.js'

const EA_SOURCES = path.resolve(import.meta.dirname, '../../../ea/src/seti_ea')

/** Seti control tools and the ones every agent gets. */
const AGENT_SIDE = [...SETI_TOOLS, ...HANDOFF_TOOLS, ...REQUEST_TOOLS]

/** EA tools agents do not get, each with the reason; everything else the EA has, agents have too. */
const NOT_FOR_AGENTS: Record<string, string> = {
  list_my_context_packs: "The EA's own packs; agents change theirs with link_context_pack.",
  change_my_context_packs: "The EA's own packs; agents change theirs with link_context_pack.",
  list_my_channels: "The channels that reach the EA's inbox, which agents do not have.",
  get_ea_settings: "The EA's wake word, how long it stays awake and how it addresses the user.",
  update_ea_settings: "The EA's wake word, how long it stays awake and how it addresses the user.",
  schedule_followup: 'Check-backs the EA delivers to itself or to the user on a call.',
  list_followups: 'Check-backs the EA delivers to itself or to the user on a call.',
  cancel_followup: 'Check-backs the EA delivers to itself or to the user on a call.',
  watch_task: "Watches feed the EA's inbox.",
  list_watches: "Watches feed the EA's inbox.",
  reply_team_chat: 'Answers a mention of @ea as the EA; agents post with post_team_chat.',
  go_to_sleep: "Ends the EA's listening on a voice call.",
  confirm_asked: "Carries out the user's yes to questions the EA asked; agents ask with request_change.",
  set_agent_access: 'Per-agent access is a security setting only the user changes.',
  set_agent_profile: 'Credentials are a security setting only the user changes.',
  set_memory_cap: 'Memory and CPU caps are a security setting only the user changes.',
  set_mcp_default: 'It turns an MCP server on for every agent, the calling one included.',
  add_mcp_server: "A new server's host joins the sandbox's network allowlist.",
  add_plugin: 'A plugin folder an agent wrote would run its hooks in other agents, unsandboxed ones too.',
  set_plugin_enabled: 'It turns a plugin on for every new agent.',
  run_mod_action: 'Agents get one mod_<mod>_<command> tool per mod command offered to them.',
}

/** Agent tools the EA has no tool of the same name for, each with how the EA does the same. */
const ONLY_FOR_AGENTS: Record<string, string> = {
  request_change: 'Agents ask the user for access they lack; the EA speaks for the user, who changes it directly.',
  await_agent: 'The EA waits with watch_task once, which keeps it under its tool cap.',
  agent_activity: 'The EA skims a time window with list_tasks active, which keeps it under its tool cap.',
  read_transcript: "The EA reads a time window with get_task's window, which keeps it under its tool cap.",
}

/**
 * Actions neither the EA nor agents get a tool for, each with the reason; both see blocked agents
 * and their reason in their agent lists, so they can remind the user.
 */
const USER_ONLY: Record<string, RegExp> = {
  'Permission requests and rules are security settings; only the user answers or changes them.':
    /permission|approve|allow_tool|deny_tool/,
  'Bypass is a security setting; only the user turns it on or off.': /bypass/,
  "Publishing data outside Seti is the user's call.": /share|publish/,
}

/** Every tool name the EA declares, reading ToolSpec("name", ...) and ToolSpec(CONSTANT, ...). */
function eaToolNames(): string[] {
  const sources = fs
    .readdirSync(EA_SOURCES)
    .filter((file) => file.endsWith('.py'))
    .map((file) => fs.readFileSync(path.join(EA_SOURCES, file), 'utf8'))
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
