import { z } from 'zod'

export const PLUGIN_COMPONENT_KINDS = ['skills', 'agents', 'commands', 'hooks', 'mcp_servers', 'lsp_servers'] as const
export type PluginComponentKind = (typeof PLUGIN_COMPONENT_KINDS)[number]

/** Component names per kind, as `claude plugin details` reports them. */
export type PluginComponents = Record<PluginComponentKind, string[]>

/** A local plugin folder Seti loads into its tasks, not installed into Claude Code. */
export interface SetiPlugin {
  id: string
  name: string
  path: string
  version: string | null
  description: string
  enabled: boolean
  created_at: string
}

export interface SetiPluginView extends SetiPlugin {
  components: PluginComponents | null
  /** Why the folder no longer loads, e.g. it was moved; null when it looks fine. */
  problem: string | null
}

/** A plugin installed into Claude Code; Seti tasks load the enabled ones through user settings. */
export interface InstalledPlugin {
  id: string
  name: string
  marketplace: string | null
  version: string | null
  scope: string
  enabled: boolean
  components: PluginComponents | null
}

export interface PluginListing {
  defaults: SetiPluginView[]
  installed: InstalledPlugin[]
  /** Why the installed plugins could not be listed, e.g. the claude CLI is missing. */
  installed_error: string | null
}

export const setiPluginInput = z.object({
  path: z.string().trim().min(1, 'path is required').max(4096),
})
export type SetiPluginInput = z.infer<typeof setiPluginInput>

export const setiPluginUpdateInput = z.object({ enabled: z.boolean() })

export const setiPluginParams = z.object({ id: z.uuid() })

export const pluginListQuery = z.object({ refresh: z.enum(['0', '1']).optional() })

/** Seti default plugins a task opts out of. */
export const disabledPluginIds = z.array(z.uuid()).max(100).default([])

export function componentLabel(kind: PluginComponentKind, count: number): string {
  const nouns: Record<PluginComponentKind, string> = {
    skills: 'skill',
    agents: 'agent',
    commands: 'command',
    hooks: 'hook',
    mcp_servers: 'MCP server',
    lsp_servers: 'LSP server',
  }
  return `${String(count)} ${nouns[kind]}${count === 1 ? '' : 's'}`
}

const SAFE_NAME = /^[A-Za-z0-9][\w.-]*$/
const SAFE_ID = /^[A-Za-z0-9][\w.-]*@[A-Za-z0-9][\w.-]*$/
/** owner/repo, git and https URLs, and paths: no quotes, spaces or shell characters. */
const SAFE_SOURCE = /^[\w.~/:@#+=%,-]+$/

export const marketplaceName = z
  .string()
  .trim()
  .min(1, 'marketplace is required')
  .max(100)
  .regex(SAFE_NAME, 'A marketplace name is letters, digits, dots, hyphens or underscores')

/** A Claude Code plugin id, name@marketplace; never option-like and never shell text. */
export const pluginId = z
  .string()
  .trim()
  .min(1, 'plugin is required')
  .max(201)
  .regex(SAFE_ID, 'Use name@marketplace, such as datadog@claude-plugins-official')

export const marketplaceSource = z
  .string()
  .trim()
  .min(1, 'source is required')
  .max(2048)
  .refine((source) => !source.startsWith('-'), 'A source cannot start with -')
  .refine(
    (source) => SAFE_SOURCE.test(source),
    'Use owner/repo, a git URL or a local path; spaces, quotes and shell characters are not allowed',
  )

export const marketplaceAddInput = z.object({ source: marketplaceSource })

export const marketplaceParams = z.object({ name: marketplaceName })

export const pluginInstallInput = z.object({ id: pluginId })

export const installedPluginParams = z.object({ id: pluginId })

export const installedPluginUpdateInput = z.object({ enabled: z.boolean() })

export const pluginCatalogQuery = z.object({
  q: z.string().trim().max(200).optional(),
  marketplace: marketplaceName.optional(),
  refresh: z.enum(['0', '1']).optional(),
})

export const pluginPreviewQuery = z.object({ id: pluginId })

/** A plugin marketplace Claude Code knows; a built-in one cannot be removed. */
export interface Marketplace {
  name: string
  /** owner/repo, URL or path, as the user would type it to add the marketplace. */
  source: string
  plugin_count: number
  built_in: boolean
}

/** A plugin a configured marketplace offers, installed or not. */
export interface CatalogPlugin {
  id: string
  name: string
  marketplace: string
  description: string
  version: string | null
  installed: boolean
  install_count: number | null
}

export interface PluginCatalog {
  /** The first matches, installed and most installed first; `total` counts every match. */
  plugins: CatalogPlugin[]
  total: number
}

/** What a plugin brings, where its marketplace manifest or the marketplace checkout says. */
export interface PluginPreview {
  id: string
  description: string
  version: string | null
  /** Where Claude Code fetches the plugin from. */
  source: string
  homepage: string | null
  /** Null when only an install would show the components, e.g. a plugin in another repo. */
  components: PluginComponents | null
}

/** What a Claude Code plugin or marketplace command reported, for a toast. */
export interface PluginActionResult {
  message: string
}

export const PLUGIN_CATALOG_LIMIT = 50
