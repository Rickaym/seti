import path from 'node:path'
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk'
import type { InstalledPlugin, PluginComponents, PluginListing, SetiPlugin, SetiPluginView } from '@seti/shared'
import { audit } from './audit.js'
import { refuseAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import { cliErrorText, createPluginCli, type DetailsTarget, type PluginCli } from './plugin-cli.js'
import { pluginStamp, readPluginFolder, resolvePluginPath, type PluginManifest } from './plugin-folder.js'
import { pluginStateFiles, stateWatch } from './plugin-state.js'
import { setiPlugins, taskPluginChoices } from './store/plugins.js'

type PluginChoices = Readonly<Record<string, boolean>>

/** Whether a task loads a plugin: its own choice, else the plugin's default. */
export const pluginLoaded = (plugin: SetiPlugin, choices: PluginChoices) => choices[plugin.id] ?? plugin.enabled

/** The SDK `plugins` option: Seti plugins on by default or chosen, minus the ones turned off. */
export function sdkPlugins(plugins: readonly SetiPlugin[], choices: PluginChoices): SdkPluginConfig[] {
  return plugins
    .filter((plugin) => pluginLoaded(plugin, choices))
    .map((plugin) => ({ type: 'local', path: plugin.path }))
}

/** Plugins the capability probe loads, so Capabilities lists what a new task would get. */
export const defaultPluginConfigs = async () => sdkPlugins(await setiPlugins.list(), {})

/** Read on every turn, so changing a default or a choice applies to the next message. */
export const taskPluginConfigs = async (taskId: string) =>
  sdkPlugins(await setiPlugins.list(), await taskPluginChoices.get(taskId))

/** Names of the plugins a task loads and the ones on by default it left out, for the audit log. */
export async function taskPluginNames(
  choices: PluginChoices,
): Promise<{ plugins: string[]; disabled_plugins: string[] }> {
  const all = await setiPlugins.list()
  return {
    plugins: all.filter((plugin) => pluginLoaded(plugin, choices)).map((plugin) => plugin.name),
    disabled_plugins: all
      .filter((plugin) => plugin.enabled && !pluginLoaded(plugin, choices))
      .map((plugin) => plugin.name),
  }
}

const DETAILS_CONCURRENCY = 4

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += limit) {
    results.push(...(await Promise.all(items.slice(i, i + limit).map(fn))))
  }
  return results
}

function readFolder(folder: string): { manifest: PluginManifest } | { problem: string } {
  try {
    return { manifest: readPluginFolder(folder) }
  } catch (e) {
    return { problem: e instanceof Error ? e.message : String(e) }
  }
}

/** The plugin with the version and description its folder names now, stored and audited if new. */
async function withFolderManifest(plugin: SetiPlugin, manifest: PluginManifest): Promise<SetiPlugin> {
  const { version, description } = manifest
  if (version === plugin.version && description === plugin.description) {
    return plugin
  }
  await setiPlugins.refreshManifest(plugin.id, { version, description })
  const was = plugin.version ?? 'no version'
  await audit.record({
    actor: 'system',
    kind: 'plugin.default_refreshed',
    subject_type: 'plugin',
    subject_id: plugin.id,
    summary: `Seti default plugin ${plugin.name} is now ${version ?? 'without a version'} (was ${was})`,
    detail: { name: plugin.name, path: plugin.path, version, was: plugin.version },
  })
  return { ...plugin, version, description }
}

/** Seti defaults and installed plugins; cached until refreshed, changed here or seen `changed`. */
export function createPluginCatalog(
  cli: Pick<PluginCli, 'installed' | 'components'> = createPluginCli(),
  changed: () => boolean = stateWatch(pluginStateFiles()),
) {
  const components = new Map<string, Promise<PluginComponents | null>>()
  let installed: Promise<InstalledPlugin[]> | null = null

  const componentsOf = async (key: string, target: DetailsTarget) => {
    const cached = components.get(key)
    if (cached) {
      return cached
    }
    const next = cli.components(target).catch(() => null)
    components.set(key, next)
    void next.then((read) => {
      if (read === null && components.get(key) === next) {
        components.delete(key)
      }
    })
    return next
  }

  const loadInstalled = async (): Promise<InstalledPlugin[]> => {
    const entries = await cli.installed()
    return mapLimited(entries, DETAILS_CONCURRENCY, async (entry) => ({
      ...entry,
      components: await componentsOf(`installed:${entry.id}@${entry.version ?? ''}`, { id: entry.id }),
    }))
  }

  const defaultView = async (stored: SetiPlugin): Promise<SetiPluginView> => {
    const read = readFolder(stored.path)
    if ('problem' in read) {
      return { ...stored, problem: read.problem, components: null }
    }
    const plugin = await withFolderManifest(stored, read.manifest)
    const target = { name: plugin.name, path: plugin.path }
    const key = `seti:${plugin.path}@${plugin.version ?? ''}@${pluginStamp(plugin.path)}`
    return { ...plugin, problem: null, components: await componentsOf(key, target) }
  }

  const list = async (refresh = false): Promise<PluginListing> => {
    if (refresh) {
      components.clear()
    }
    if (changed() || refresh) {
      installed = null
    }
    installed ??= loadInstalled()
    const current = installed
    const [defaults, result] = await Promise.all([
      setiPlugins.list().then(async (plugins) => mapLimited(plugins, DETAILS_CONCURRENCY, defaultView)),
      current.then(
        (plugins) => ({ plugins, error: null }),
        (e: unknown) => ({ plugins: [], error: cliErrorText(e) }),
      ),
    ])
    if (result.error !== null && installed === current) {
      installed = null
    }
    return { defaults, installed: result.plugins, installed_error: result.error }
  }

  const invalidate = () => {
    installed = null
  }

  return { list, invalidate }
}

export const pluginCatalog = createPluginCatalog()

async function auditPlugin(
  kind: 'plugin.default_added' | 'plugin.default_enabled' | 'plugin.default_disabled' | 'plugin.default_removed',
  plugin: SetiPlugin,
  verb: string,
  actor: 'user' | 'system' = 'user',
): Promise<void> {
  await audit.record({
    actor,
    kind,
    subject_type: 'plugin',
    subject_id: plugin.id,
    summary: `${verb} Seti default plugin ${plugin.name} (${plugin.path})`,
    detail: { name: plugin.name, path: plugin.path, version: plugin.version, enabled: plugin.enabled },
  })
}

async function requireSetiPlugin(id: string): Promise<SetiPlugin> {
  const plugin = await setiPlugins.get(id)
  if (!plugin) {
    throw new HttpError(404, 'Plugin not found')
  }
  return plugin
}

export async function addDefaultPlugin(rawPath: string): Promise<SetiPlugin> {
  refuseAgent('add default plugins')
  const folder = resolvePluginPath(rawPath)
  const manifest = readPluginFolder(folder)
  const plugin = await setiPlugins.create({ ...manifest, path: folder })
  await auditPlugin('plugin.default_added', plugin, 'Added')
  return plugin
}

export async function setDefaultPluginEnabled(id: string, enabled: boolean): Promise<SetiPlugin> {
  if (enabled) {
    refuseAgent('turn default plugins on')
  }
  const before = await requireSetiPlugin(id)
  if (before.enabled === enabled) {
    return before
  }
  await setiPlugins.setEnabled(id, enabled)
  const after = await requireSetiPlugin(id)
  await auditPlugin(
    enabled ? 'plugin.default_enabled' : 'plugin.default_disabled',
    after,
    enabled ? 'Enabled' : 'Disabled',
  )
  return after
}

export async function removeDefaultPlugin(id: string): Promise<void> {
  const plugin = await requireSetiPlugin(id)
  await setiPlugins.remove(id)
  await auditPlugin('plugin.default_removed', plugin, 'Removed')
}

/** The group chat plugin Seti once registered from its checkout; the task workspace replaced it. */
const RETIRED_PLUGIN = { name: 'seti-team', folder: `${path.sep}plugins${path.sep}seti-team` }

/** Removes the retired group chat plugin from the Seti defaults, once, as the system. */
export async function retireBundledPlugins(): Promise<void> {
  for (const plugin of await setiPlugins.list()) {
    if (plugin.name === RETIRED_PLUGIN.name && plugin.path.endsWith(RETIRED_PLUGIN.folder)) {
      await setiPlugins.remove(plugin.id)
      await auditPlugin('plugin.default_removed', plugin, 'Removed', 'system')
    }
  }
}
