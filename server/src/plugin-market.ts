import {
  PLUGIN_CATALOG_LIMIT,
  type AuditKind,
  type CatalogPlugin,
  type Marketplace,
  type PluginActionResult,
  type PluginCatalog,
  type PluginPreview,
} from '@seti/shared'
import { audit } from './audit.js'
import { refuseAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import {
  changeArgs,
  CHANGEABLE_SCOPES,
  CliTimeout,
  cliErrorText,
  createPluginCli,
  type AvailablePlugin,
  type ChangeableScope,
  type ConfiguredMarketplace,
  type InstalledEntry,
  type PluginCli,
} from './plugin-cli.js'
import {
  declaredComponents,
  localPluginFolder,
  mergeComponents,
  readManifest,
  type ManifestPlugin,
  type MarketplaceManifest,
} from './plugin-manifest.js'
import { pluginStateFiles, stateWatch } from './plugin-state.js'
import { pluginCatalog } from './plugins.js'

interface Snapshot {
  marketplaces: ConfiguredMarketplace[]
  installed: InstalledEntry[]
  available: AvailablePlugin[]
  manifests: Map<string, MarketplaceManifest>
}

function splitId(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf('@')
  return { name: id.slice(0, at), marketplace: id.slice(at + 1) }
}

function catalogEntries(snapshot: Snapshot): CatalogPlugin[] {
  const installed = snapshot.installed.flatMap((entry): CatalogPlugin[] => {
    if (entry.marketplace === null) {
      return []
    }
    const manifest = snapshot.manifests.get(entry.marketplace)?.plugins.get(entry.name)
    const { id, name, marketplace, version } = entry
    const description = manifest?.description ?? ''
    return [{ id, name, marketplace, description, version, installed: true, install_count: null }]
  })
  const ids = new Set(installed.map((entry) => entry.id))
  const available = snapshot.available
    .filter((entry) => !ids.has(entry.id))
    .map((entry): CatalogPlugin => ({
      id: entry.id,
      name: entry.name,
      marketplace: entry.marketplace,
      description: entry.description,
      version: entry.version,
      installed: false,
      install_count: entry.installCount,
    }))
  return [...installed, ...available]
}

/** Installed first, then the most installed, then by name. */
function catalogOrder(a: CatalogPlugin, b: CatalogPlugin): number {
  if (a.installed !== b.installed) {
    return a.installed ? -1 : 1
  }
  const installs = (b.install_count ?? -1) - (a.install_count ?? -1)
  return installs === 0 ? a.name.localeCompare(b.name) : installs
}

const searchWords = (query: string) =>
  query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '')

/** The preview of a plugin on offer, from the CLI's listing and its marketplace's manifest. */
function previewOf(snapshot: Snapshot, id: string): { preview: PluginPreview; folder: string | null } {
  const { name, marketplace } = splitId(id)
  const offered = snapshot.available.find((entry) => entry.id === id)
  const installed = snapshot.installed.find((entry) => entry.id === id)
  if (offered === undefined && installed === undefined) {
    throw new HttpError(404, `No plugin ${id} in the configured marketplaces`)
  }
  const listed = offered ?? { description: '', version: installed?.version ?? null, source: '' }
  const manifest = snapshot.manifests.get(marketplace)
  const entry = manifest?.plugins.get(name)
  const declared = manifestFields(entry)
  return {
    preview: {
      id,
      description: listed.description === '' ? declared.description : listed.description,
      version: listed.version ?? declared.version,
      source: listed.source === '' ? declared.source : listed.source,
      homepage: declared.homepage,
      components: declaredComponents(entry),
    },
    folder: manifest === undefined || entry === undefined ? null : localPluginFolder(manifest, entry),
  }
}

function manifestFields(entry: ManifestPlugin | undefined) {
  return {
    description: entry?.description ?? '',
    version: entry?.version ?? null,
    source: typeof entry?.source === 'string' ? entry.source : '',
    homepage: entry?.homepage ?? null,
  }
}

export interface CatalogQuery {
  q?: string | undefined
  marketplace?: string | undefined
  refresh?: boolean
}

type ChangeKind = Extract<AuditKind, `plugin.${'installed' | 'uninstalled' | 'enabled' | 'disabled' | 'updated'}`>
type MarketplaceKind = Extract<AuditKind, `plugin.marketplace_${string}`>

interface ChangeSpec {
  kind: ChangeKind | MarketplaceKind
  args: string[]
  subject: string
  summary: string
  detail: Record<string, string>
}

export interface PluginMarketOptions {
  cli?: PluginCli
  changed?: () => boolean
  /** Called after every change, so other caches of Claude Code's plugins drop too. */
  onChange?: () => void
}

function changeFailure(e: unknown): HttpError {
  if (e instanceof CliTimeout) {
    return new HttpError(504, e.message)
  }
  return new HttpError((e as { code?: unknown }).code === 'ENOENT' ? 500 : 400, cliErrorText(e))
}

/** Marketplaces, the plugins they offer, and the user's installs and removals through the CLI. */
export function createPluginMarket(options: PluginMarketOptions = {}) {
  const cli = options.cli ?? createPluginCli()
  const changed = options.changed ?? stateWatch(pluginStateFiles())
  const onChange = options.onChange ?? (() => undefined)
  let snapshot: Promise<Snapshot> | null = null
  let queue: Promise<unknown> = Promise.resolve()

  const loadSnapshot = async (): Promise<Snapshot> => {
    const [marketplaces, offered] = await Promise.all([cli.marketplaces(), cli.available()])
    const manifests = new Map<string, MarketplaceManifest>()
    for (const marketplace of marketplaces) {
      const manifest = marketplace.installLocation === null ? null : readManifest(marketplace.installLocation)
      if (manifest !== null) {
        manifests.set(marketplace.name, manifest)
      }
    }
    return { marketplaces, ...offered, manifests }
  }

  const load = async (refresh = false): Promise<Snapshot> => {
    if (changed() || refresh) {
      snapshot = null
    }
    snapshot ??= loadSnapshot()
    const current = snapshot
    try {
      return await current
    } catch (e) {
      if (snapshot === current) {
        snapshot = null
      }
      throw new HttpError(502, `Could not read Claude Code plugins: ${cliErrorText(e)}`)
    }
  }

  const catalog = async (query: CatalogQuery): Promise<PluginCatalog> => {
    const loaded = await load(query.refresh === true)
    const terms = searchWords(query.q ?? '')
    const matches = catalogEntries(loaded)
      .filter((entry) => query.marketplace === undefined || entry.marketplace === query.marketplace)
      .filter((entry) => {
        const text = `${entry.name} ${entry.marketplace} ${entry.description}`.toLowerCase()
        return terms.every((term) => text.includes(term))
      })
      .sort(catalogOrder)
    return { plugins: matches.slice(0, PLUGIN_CATALOG_LIMIT), total: matches.length }
  }

  const marketplaces = async (refresh = false): Promise<Marketplace[]> => {
    const loaded = await load(refresh)
    const counts = new Map<string, number>()
    for (const entry of catalogEntries(loaded)) {
      counts.set(entry.marketplace, (counts.get(entry.marketplace) ?? 0) + 1)
    }
    const count = (name: string) => counts.get(name) ?? 0
    const configured = loaded.marketplaces.map(({ name, source }): Marketplace => ({
      name,
      source,
      plugin_count: count(name),
      built_in: false,
    }))
    const known = new Set(configured.map((entry) => entry.name))
    const builtIn = [...counts.keys()]
      .filter((name) => !known.has(name))
      .map((name): Marketplace => ({ name, source: 'Built in', plugin_count: count(name), built_in: true }))
    return [...configured, ...builtIn]
  }

  const preview = async (id: string): Promise<PluginPreview> => {
    const { preview: found, folder } = previewOf(await load(), id)
    if (folder === null) {
      return found
    }
    const inspected = await cli.components({ name: splitId(id).name, path: folder }).catch(() => null)
    return { ...found, components: mergeComponents(inspected, found.components) }
  }

  /** Runs one change at a time, so two installs never write Claude Code's files at once. */
  const serialized = async <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn)
    queue = next.catch(() => undefined)
    return next
  }

  const run = async (spec: ChangeSpec): Promise<PluginActionResult> => {
    let message: string
    try {
      message = await cli.change(spec.args)
    } catch (e) {
      throw changeFailure(e)
    } finally {
      snapshot = null
      onChange()
    }
    await audit.record({
      actor: 'user',
      kind: spec.kind,
      subject_type: 'plugin',
      subject_id: spec.subject,
      summary: spec.summary,
      detail: { ...spec.detail, result: message },
    })
    return { message }
  }

  const installedScope = async (id: string): Promise<ChangeableScope> => {
    const entry = (await cli.installed()).find((plugin) => plugin.id === id)
    if (entry === undefined) {
      throw new HttpError(404, `${id} is not installed`)
    }
    const scope = CHANGEABLE_SCOPES.find((known) => known === entry.scope)
    if (scope === undefined) {
      throw new HttpError(400, `${id} is installed in the ${entry.scope} scope, which Seti does not change`)
    }
    return scope
  }

  /** A change to an installed plugin, in the settings scope it is installed in. */
  const changeInstalled = async (
    id: string,
    kind: ChangeKind,
    [verb, done]: [string, string],
    args: (scope: ChangeableScope) => string[],
  ): Promise<PluginActionResult> => {
    refuseAgent(`${verb} Claude Code plugins`)
    return serialized(async () => {
      const scope = await installedScope(id)
      const summary = `${done} Claude Code plugin ${id}`
      return run({ kind, args: args(scope), subject: id, summary, detail: { id, scope } })
    })
  }

  const install = async (id: string): Promise<PluginActionResult> => {
    refuseAgent('install Claude Code plugins')
    return serialized(async () =>
      run({
        kind: 'plugin.installed',
        args: changeArgs.install(id),
        subject: id,
        summary: `Installed Claude Code plugin ${id}`,
        detail: { id, scope: 'user' },
      }),
    )
  }

  const uninstall = async (id: string) =>
    changeInstalled(id, 'plugin.uninstalled', ['uninstall', 'Uninstalled'], (scope) => changeArgs.uninstall(id, scope))

  const setEnabled = async (id: string, enabled: boolean) =>
    enabled
      ? changeInstalled(id, 'plugin.enabled', ['enable', 'Enabled'], (scope) => changeArgs.enable(id, scope))
      : changeInstalled(id, 'plugin.disabled', ['disable', 'Disabled'], (scope) => changeArgs.disable(id, scope))

  const update = async (id: string) =>
    changeInstalled(id, 'plugin.updated', ['update', 'Updated'], (scope) => changeArgs.update(id, scope))

  const addMarketplace = async (source: string): Promise<PluginActionResult> => {
    refuseAgent('add plugin marketplaces')
    return serialized(async () =>
      run({
        kind: 'plugin.marketplace_added',
        args: changeArgs.addMarketplace(source),
        subject: source,
        summary: `Added plugin marketplace ${source}`,
        detail: { source },
      }),
    )
  }

  const updateMarketplace = async (name: string): Promise<PluginActionResult> => {
    refuseAgent('update plugin marketplaces')
    return serialized(async () =>
      run({
        kind: 'plugin.marketplace_updated',
        args: changeArgs.updateMarketplace(name),
        subject: name,
        summary: `Updated plugin marketplace ${name}`,
        detail: { name },
      }),
    )
  }

  const removeMarketplace = async (name: string): Promise<PluginActionResult> => {
    refuseAgent('remove plugin marketplaces')
    return serialized(async () => {
      const entry = (await cli.marketplaces()).find((marketplace) => marketplace.name === name)
      if (entry === undefined) {
        throw new HttpError(404, `No configured marketplace ${name}`)
      }
      return run({
        kind: 'plugin.marketplace_removed',
        args: changeArgs.removeMarketplace(name),
        subject: name,
        summary: `Removed plugin marketplace ${name} (${entry.source})`,
        detail: { name, source: entry.source },
      })
    })
  }

  return {
    catalog,
    marketplaces,
    preview,
    install,
    uninstall,
    setEnabled,
    update,
    addMarketplace,
    updateMarketplace,
    removeMarketplace,
  }
}

export const pluginMarket = createPluginMarket({
  onChange: () => {
    pluginCatalog.invalidate()
  },
})
