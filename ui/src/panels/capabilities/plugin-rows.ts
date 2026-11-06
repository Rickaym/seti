import {
  PLUGIN_COMPONENT_KINDS,
  type InstalledPlugin,
  type PluginComponents,
  type PluginListing,
  type SetiPluginView,
} from '@seti/shared'
import { matches } from './filter'

export interface PluginRow {
  key: string
  name: string
  version: string | null
  origin: string
  scope: string | null
  enabled: boolean
  /** Folder of a Seti default or the name@marketplace id of an installed plugin. */
  detail: string
  components: PluginComponents | null
  problem: string | null
  seti: SetiPluginView | null
  claude: InstalledPlugin | null
}

export function pluginRows(listing: PluginListing): PluginRow[] {
  const defaults = listing.defaults.map((plugin): PluginRow => ({
    key: `seti:${plugin.id}`,
    name: plugin.name,
    version: plugin.version,
    origin: 'Seti default',
    scope: 'seti',
    enabled: plugin.enabled,
    detail: plugin.path,
    components: plugin.components,
    problem: plugin.problem,
    seti: plugin,
    claude: null,
  }))
  const installed = listing.installed.map((plugin): PluginRow => ({
    key: `claude:${plugin.id}`,
    name: plugin.name,
    version: plugin.version,
    origin: plugin.marketplace ?? '-',
    scope: plugin.scope,
    enabled: plugin.enabled,
    detail: plugin.id,
    components: plugin.components,
    problem: null,
    seti: null,
    claude: plugin,
  }))
  return [...defaults, ...installed]
}

const allNames = (components: PluginComponents | null) =>
  components === null ? [] : PLUGIN_COMPONENT_KINDS.flatMap((kind) => components[kind])

/** A plugin shows when its name or origin matches, or when any of its components does. */
export const filterPlugins = (rows: PluginRow[], query: string) =>
  rows.filter((row) => matches(query, row.name, row.origin, ...allNames(row.components)))
