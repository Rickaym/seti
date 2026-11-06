import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import type { InstalledPlugin, PluginComponentKind, PluginComponents } from '@seti/shared'
import { z } from 'zod'
import { probeEnv } from './capabilities.js'
import { CLAUDE_BIN } from './config.js'

const exec = promisify(execFile)

/** Reads answer from local files; changes may clone a repo, which the CLI itself gives 120 s. */
export const CLI_TIMEOUT_MS = { read: 60_000, change: 180_000 } as const
const MAX_OUTPUT = 32 * 1024 * 1024

/** Runs the claude CLI with an argument list, never through a shell, and returns stdout. */
export type RunCli = (args: string[], timeoutMs?: number) => Promise<string>

/** What a CLI run that ran out of time rejects with; its message names the limit. */
export class CliTimeout extends Error {}

/** "plugin marketplace add" out of its arguments: the words from `plugin` up to the first option. */
function commandWords(args: readonly string[]): string {
  const start = Math.max(0, args.indexOf('plugin'))
  const rest = args.slice(start)
  const end = rest.findIndex((arg) => arg.startsWith('-'))
  return (end < 0 ? rest : rest.slice(0, end)).join(' ')
}

/** A runner for `bin`; a run that outlives its timeout is killed and rejects with CliTimeout. */
export function cliRunner(bin: string): RunCli {
  return async (args, timeoutMs = CLI_TIMEOUT_MS.read) => {
    try {
      const { stdout } = await exec(bin, args, {
        cwd: os.homedir(),
        env: probeEnv(),
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT,
      })
      return stdout
    } catch (e) {
      const error = e as { killed?: unknown; signal?: unknown }
      if (error.killed === true && error.signal === 'SIGTERM') {
        const seconds = String(timeoutMs / 1000)
        throw new CliTimeout(`claude ${commandWords(args)} did not finish within ${seconds} s`)
      }
      throw e
    }
  }
}

const runClaudeCli = cliRunner(CLAUDE_BIN)

/** A plugin to inspect: an installed one by its name@marketplace id, or a local folder by path. */
export type DetailsTarget = { id: string } | { name: string; path: string }

export const LIST_ARGS = ['plugin', 'list', '--json'] as const

/** `claude plugin details` arguments; a local folder is loaded for this call only as name@inline. */
export function detailsArgs(target: DetailsTarget): string[] {
  if ('path' in target) {
    return ['--plugin-dir', target.path, 'plugin', 'details', '--', `${target.name}@inline`]
  }
  return ['plugin', 'details', '--', target.id]
}

const listSchema = z.array(
  z.object({
    id: z.string().min(1),
    version: z.string().optional(),
    scope: z.string().optional(),
    enabled: z.boolean().optional(),
  }),
)

export type InstalledEntry = Omit<InstalledPlugin, 'components'>

/** Parses `claude plugin list --json`; ids look like name@marketplace. */
export function parseInstalled(stdout: string): InstalledEntry[] {
  return listSchema.parse(JSON.parse(stdout)).map((entry) => {
    const at = entry.id.lastIndexOf('@')
    return {
      id: entry.id,
      name: at > 0 ? entry.id.slice(0, at) : entry.id,
      marketplace: at > 0 ? entry.id.slice(at + 1) : null,
      version: entry.version ?? null,
      scope: entry.scope ?? 'user',
      enabled: entry.enabled ?? true,
    }
  })
}

const INVENTORY_LABELS: Partial<Record<string, PluginComponentKind>> = {
  Skills: 'skills',
  Agents: 'agents',
  Commands: 'commands',
  Hooks: 'hooks',
  'MCP servers': 'mcp_servers',
  'LSP servers': 'lsp_servers',
}

const emptyComponents = (): PluginComponents => ({
  skills: [],
  agents: [],
  commands: [],
  hooks: [],
  mcp_servers: [],
  lsp_servers: [],
})

interface InventoryLine {
  label: string
  names: string[]
}

/** Splits "  Skills (2)  a, b  (note)" into its label and names; null for any other line. */
function inventoryLine(line: string): InventoryLine | null {
  const text = line.trim()
  const open = text.indexOf(' (')
  const close = text.indexOf(')', open)
  if (!line.startsWith(' ') || open <= 0 || close < 0 || !/^\d+$/.test(text.slice(open + 2, close))) {
    return null
  }
  const rest = text.slice(close + 1).trim()
  const note = rest.indexOf('  (')
  const names = (note < 0 ? rest : rest.slice(0, note)).split(',')
  return { label: text.slice(0, open), names: names.map((name) => name.trim()).filter((name) => name !== '') }
}

/** Reads the "Component inventory" block of `claude plugin details`; null when it is missing. */
export function parseDetails(stdout: string): PluginComponents | null {
  const lines = stdout.split('\n')
  const start = lines.findIndex((line) => line.trim() === 'Component inventory')
  if (start < 0) {
    return null
  }
  const components = emptyComponents()
  for (const line of lines.slice(start + 1)) {
    const entry = inventoryLine(line)
    if (entry === null) {
      break
    }
    const kind = INVENTORY_LABELS[entry.label]
    if (kind !== undefined) {
      components[kind] = entry.names
    }
  }
  return components
}

const MARKETPLACE_LIST_ARGS = ['plugin', 'marketplace', 'list', '--json'] as const
const AVAILABLE_ARGS = ['plugin', 'list', '--available', '--json'] as const

/** Settings scopes Seti may change a plugin in; managed plugins belong to the administrator. */
export const CHANGEABLE_SCOPES = ['user', 'project', 'local'] as const
export type ChangeableScope = (typeof CHANGEABLE_SCOPES)[number]

/** Each change prints one JSON result line and takes its target after `--`, never as an option. */
export const changeArgs = {
  install: (id: string) => ['plugin', 'install', '--json', '--scope', 'user', '--', id],
  uninstall: (id: string, scope: ChangeableScope) => ['plugin', 'uninstall', '--json', '--scope', scope, '--', id],
  enable: (id: string, scope: ChangeableScope) => ['plugin', 'enable', '--json', '--scope', scope, '--', id],
  disable: (id: string, scope: ChangeableScope) => ['plugin', 'disable', '--json', '--scope', scope, '--', id],
  update: (id: string, scope: ChangeableScope) => ['plugin', 'update', '--json', '--scope', scope, '--', id],
  addMarketplace: (source: string) => ['plugin', 'marketplace', 'add', '--json', '--', source],
  updateMarketplace: (name: string) => ['plugin', 'marketplace', 'update', '--json', '--', name],
  removeMarketplace: (name: string) => ['plugin', 'marketplace', 'remove', '--json', '--', name],
}

/** A marketplace as `claude plugin marketplace list --json` reports it. */
export interface ConfiguredMarketplace {
  name: string
  source: string
  installLocation: string | null
}

const marketplaceListSchema = z.array(
  z.looseObject({
    name: z.string().min(1),
    source: z.string().optional(),
    repo: z.string().optional(),
    url: z.string().optional(),
    path: z.string().optional(),
    installLocation: z.string().optional(),
  }),
)

export function parseMarketplaces(stdout: string): ConfiguredMarketplace[] {
  return marketplaceListSchema.parse(JSON.parse(stdout)).map((entry) => ({
    name: entry.name,
    source: entry.repo ?? entry.url ?? entry.path ?? entry.source ?? '',
    installLocation: entry.installLocation ?? null,
  }))
}

/** Where a plugin comes from, as text: a path in its marketplace, a repo, a URL or a package. */
function sourceText(source: unknown): string {
  if (typeof source === 'string') {
    return source
  }
  if (typeof source !== 'object' || source === null) {
    return ''
  }
  const fields = source as Record<string, unknown>
  const named = ['url', 'repo', 'package', 'path'].map((key) => fields[key]).find((value) => typeof value === 'string')
  return typeof named === 'string' ? named : ''
}

/** A plugin the configured marketplaces offer that is not installed. */
export interface AvailablePlugin {
  id: string
  name: string
  marketplace: string
  description: string
  version: string | null
  source: string
  installCount: number | null
}

const availableSchema = z.object({
  installed: listSchema,
  available: z.array(
    z.object({
      pluginId: z.string().min(1),
      name: z.string().min(1),
      marketplaceName: z.string().min(1),
      description: z.string().optional(),
      version: z.string().optional(),
      source: z.unknown().optional(),
      installCount: z.number().optional(),
    }),
  ),
})

/** Parses `claude plugin list --available --json`: installed plugins, then the rest on offer. */
export function parseAvailable(stdout: string): { installed: InstalledEntry[]; available: AvailablePlugin[] } {
  const parsed = availableSchema.parse(JSON.parse(stdout))
  return {
    installed: parseInstalled(JSON.stringify(parsed.installed)),
    available: parsed.available.map((entry) => ({
      id: entry.pluginId,
      name: entry.name,
      marketplace: entry.marketplaceName,
      description: entry.description ?? '',
      version: entry.version ?? null,
      source: sourceText(entry.source),
      installCount: entry.installCount ?? null,
    })),
  }
}

const resultSchema = z.looseObject({ outcome: z.string().optional(), message: z.string().optional() })

/** The JSON result line a change prints last, or null when stdout has none. */
function resultLine(stdout: string): z.infer<typeof resultSchema> | null {
  const line = stdout.trim().split('\n').at(-1) ?? ''
  try {
    const parsed = resultSchema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

const lastLine = (text: string) => text.trim().split('\n').at(-1)?.trim() ?? ''

/** What a change reported: its message's last line; a result other than ok throws it. */
export function changeMessage(stdout: string): string {
  const result = resultLine(stdout)
  if (result?.outcome !== undefined && result.outcome !== 'ok') {
    throw new Error(result.message ?? `claude plugin reported ${result.outcome}`)
  }
  return lastLine(result?.message ?? stdout)
}

/** The CLI's own words for a failure: its JSON result message, else stderr, else the error. */
export function cliErrorText(e: unknown): string {
  const error = e as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown }
  if (error.code === 'ENOENT') {
    return `Claude Code CLI not found (${CLAUDE_BIN}); set SETI_CLAUDE_BIN`
  }
  const result = typeof error.stdout === 'string' ? resultLine(error.stdout) : null
  if (result?.message !== undefined && result.message.trim() !== '') {
    return result.message.trim()
  }
  const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : ''
  if (stderr !== '') {
    return stderr
  }
  return typeof error.message === 'string' ? error.message : 'claude plugin failed'
}

/** Plugin and marketplace queries, and the changes the user starts from Settings. */
export function createPluginCli(run: RunCli = runClaudeCli) {
  return {
    installed: async () => parseInstalled(await run([...LIST_ARGS])),
    components: async (target: DetailsTarget) => parseDetails(await run(detailsArgs(target))),
    marketplaces: async () => parseMarketplaces(await run([...MARKETPLACE_LIST_ARGS])),
    available: async () => parseAvailable(await run([...AVAILABLE_ARGS])),
    change: async (args: string[]) => changeMessage(await run(args, CLI_TIMEOUT_MS.change)),
  }
}

export type PluginCli = ReturnType<typeof createPluginCli>
