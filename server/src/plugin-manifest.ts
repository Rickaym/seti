import fs from 'node:fs'
import path from 'node:path'
import { PLUGIN_COMPONENT_KINDS, type PluginComponentKind, type PluginComponents } from '@seti/shared'
import { z } from 'zod'

const MANIFEST = path.join('.claude-plugin', 'marketplace.json')

const pathList = z.union([z.string(), z.array(z.string())])
const manifestPlugin = z.looseObject({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  homepage: z.string().optional(),
  source: z.unknown().optional(),
  skills: pathList.optional(),
  commands: pathList.optional(),
  agents: pathList.optional(),
  hooks: z.unknown().optional(),
  mcpServers: z.unknown().optional(),
  lspServers: z.unknown().optional(),
})
export type ManifestPlugin = z.infer<typeof manifestPlugin>

const manifestSchema = z.looseObject({
  metadata: z.looseObject({ pluginRoot: z.string().optional() }).optional(),
  plugins: z.array(z.unknown()),
})

/** A marketplace checkout's `.claude-plugin/marketplace.json`, with its plugins by name. */
export interface MarketplaceManifest {
  root: string
  pluginRoot: string
  plugins: Map<string, ManifestPlugin>
}

/** Reads a marketplace checkout's manifest, read-only; null when it is missing or broken. */
export function readManifest(root: string): MarketplaceManifest | null {
  try {
    const parsed = manifestSchema.parse(JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8')))
    const plugins = new Map<string, ManifestPlugin>()
    for (const raw of parsed.plugins) {
      const entry = manifestPlugin.safeParse(raw)
      if (entry.success) {
        plugins.set(entry.data.name, entry.data)
      }
    }
    return { root, pluginRoot: parsed.metadata?.pluginRoot ?? '', plugins }
  } catch {
    return null
  }
}

const baseName = (file: string) => path.basename(file).replace(/\.(md|json)$/, '')

function names(value: unknown): string[] {
  if (typeof value === 'string') {
    return [baseName(value)]
  }
  if (Array.isArray(value)) {
    return value.flatMap(names)
  }
  if (typeof value === 'object' && value !== null) {
    const inner = (value as { hooks?: unknown }).hooks
    return typeof inner === 'object' && inner !== null ? Object.keys(inner) : Object.keys(value)
  }
  return []
}

const MANIFEST_FIELDS: Record<PluginComponentKind, keyof ManifestPlugin> = {
  skills: 'skills',
  agents: 'agents',
  commands: 'commands',
  hooks: 'hooks',
  mcp_servers: 'mcpServers',
  lsp_servers: 'lspServers',
}

const byKind = (pick: (kind: PluginComponentKind) => string[]) =>
  Object.fromEntries(PLUGIN_COMPONENT_KINDS.map((kind) => [kind, pick(kind)])) as PluginComponents

/** The components a marketplace entry declares itself; null when it declares none. */
export function declaredComponents(entry: ManifestPlugin | undefined): PluginComponents | null {
  if (entry === undefined || PLUGIN_COMPONENT_KINDS.every((kind) => entry[MANIFEST_FIELDS[kind]] === undefined)) {
    return null
  }
  return byKind((kind) => names(entry[MANIFEST_FIELDS[kind]]))
}

export function mergeComponents(a: PluginComponents | null, b: PluginComponents | null): PluginComponents | null {
  if (a === null || b === null) {
    return a ?? b
  }
  return byKind((kind) => [...new Set([...a[kind], ...b[kind]])])
}

const inside = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

const isFolder = (dir: string) => fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true

/** A plugin folder inside its marketplace checkout, for a relative source; null otherwise. */
export function localPluginFolder(manifest: MarketplaceManifest, entry: ManifestPlugin): string | null {
  const { source } = entry
  if (typeof source !== 'string' || path.isAbsolute(source)) {
    return null
  }
  const candidates = [path.resolve(manifest.root, source), path.resolve(manifest.root, manifest.pluginRoot, source)]
  return candidates.find((dir) => inside(manifest.root, dir) && isFolder(dir)) ?? null
}
