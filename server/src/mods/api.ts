import type { ModCommandCall, ModFetchResponse, ServerModApi } from '@seti/mod-api'
import {
  grantScopes,
  modScoped,
  type Disposer,
  type ModCapabilityName,
  type ModChannelSource,
  type ModManifest,
  type ModOp,
} from '@seti/shared'
import { asMod, forAsker } from '../access.js'
import { modWebhookAdapter, modWebhookInfo, pollerTemplates, webhookSources } from '../channels/sources.js'
import { HttpError } from '../http.js'
import { asideApi } from './aside.js'
import { requireOp } from './capabilities.js'
import { runModOp } from './ops/table.js'
import { modCommands, modRouteEntries } from './points.js'
import { hostProxyApi, prsApi } from './pr-api.js'
import { transcriptApi } from './transcript.js'
import { versionApi } from './version.js'
import { workspacesApi } from './workspace-layouts.js'
import { cache } from '../redis.js'
import { MOD_DATA_KEY_MAX } from '../store/mods.js'

/** How long and how large a mod's cached values may be, so no mod fills Redis. */
const CACHE_LIMITS = { ttlMaxSeconds: 24 * 3600, valueMaxBytes: 256 * 1024 }

const clip = (text: string, max: number) => text.slice(0, max)

/** The mod a mod API call acts for, and where its registrations are kept for turning it off. */
export interface ApiTarget {
  manifest: ModManifest
  grants: readonly ModCapabilityName[]
  track: (dispose: Disposer) => Disposer
}

type Run = <T>(fn: () => Promise<T>) => Promise<T>

function checkedKey(key: string): string {
  if (key === '' || key.length > MOD_DATA_KEY_MAX) {
    throw new HttpError(400, `A storage key is 1 to ${String(MOD_DATA_KEY_MAX)} characters`)
  }
  return key
}

function cacheOf(run: Run): ServerModApi['cache'] {
  const keyOf = (id: string, key: string) => `mod:${id}:${checkedKey(key)}`
  return {
    get: async (key) => run(async () => cache.get(keyOf(requireOp('storage.get').modId, key))),
    set: async (key, value, ttlSeconds) =>
      run(async () => {
        const id = requireOp('storage.set').modId
        if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > CACHE_LIMITS.ttlMaxSeconds) {
          throw new HttpError(400, `A cached value lives 1 to ${String(CACHE_LIMITS.ttlMaxSeconds)} seconds`)
        }
        if (Buffer.byteLength(JSON.stringify(value ?? null)) > CACHE_LIMITS.valueMaxBytes) {
          throw new HttpError(413, `A cached value is at most ${String(CACHE_LIMITS.valueMaxBytes / 1024)} KB`)
        }
        await cache.set(keyOf(id, key), value, ttlSeconds)
      }),
  }
}

/** The mod's own `SETI_<ID>_<NAME>` variable; it reads no other part of Seti's environment. */
function envOf(id: string): ServerModApi['env'] {
  const prefix = `SETI_${id.toUpperCase().replaceAll('-', '_')}_`
  return (name) => (/^[A-Z][A-Z0-9_]*$/.test(name) ? process.env[prefix + name] : undefined)
}

const ofKind =
  <K extends ModChannelSource['kind']>(kind: K) =>
  (entry: ModChannelSource): entry is Extract<ModChannelSource, { kind: K }> =>
    entry.kind === kind

type RouteMethod = ModManifest['contributes']['routes'][number]['method']

function declaredRoute(manifest: ModManifest, method: RouteMethod, path: string, stream: boolean) {
  const declared = manifest.contributes.routes.find((route) => route.method === method && route.path === path)
  if (declared === undefined) {
    throw new Error(`${manifest.id} answers ${method} ${path}, which its manifest does not declare`)
  }
  if (declared.stream !== stream) {
    const how = stream ? 'streams' : 'answers JSON from'
    throw new Error(`${manifest.id} ${how} ${method} ${path}, which its manifest declares otherwise`)
  }
  return { mod: manifest.id, method, path, demo: declared.demo }
}

function declaredSource<K extends ModChannelSource['kind']>(manifest: ModManifest, kind: K, id: string) {
  const found = manifest.contributes.channelSources.filter(ofKind(kind)).find((entry) => entry.id === id)
  if (found === undefined) {
    throw new Error(`${manifest.id} registers the ${kind} source ${id}, which its manifest does not declare`)
  }
  return found
}

/** The mod API one mod's server half gets: each call runs the op table as the mod, in its grants. */
export function serverApi(target: ApiTarget): ServerModApi {
  const { manifest } = target
  const scopes = grantScopes(manifest.capabilities.filter((capability) => target.grants.includes(capability.name)))
  const run: Run = async (fn) => asMod({ id: manifest.id, grants: target.grants, scopes }, fn)
  const op = async (name: ModOp, args: Record<string, unknown>) => run(async () => runModOp(name, args, manifest))
  return {
    id: manifest.id,
    manifest,
    settings: { get: async () => (await op('settings.get', {})) as Record<string, unknown> },
    storage: {
      get: async (key) => op('storage.get', { key }),
      keys: async () => (await op('storage.keys', {})) as string[],
      set: async (key, value) => {
        await op('storage.set', { key, value })
      },
      delete: async (key) => {
        await op('storage.delete', { key })
      },
    },
    cache: cacheOf(run),
    env: envOf(manifest.id),
    version: versionApi(run),
    workspaces: workspacesApi(run),
    notify: async (kind, note) => {
      const args = { kind, title: clip(note.title, 120), body: clip(note.body, 240), url: note.url }
      return ((await op('notify.send', args)) as { sent: number }).sent
    },
    audit: async (kind, summary, detail) => {
      await op('audit.record', { kind, summary: clip(summary, 300), detail })
    },
    fetch: async (url, init) => (await op('net.fetch', { url, ...init })) as ModFetchResponse,
    route: (method, path, handle) =>
      target.track(
        modRouteEntries.register({ ...declaredRoute(manifest, method, path, false), stream: false, handle }),
      ),
    streamRoute: (method, path, handle) =>
      target.track(modRouteEntries.register({ ...declaredRoute(manifest, method, path, true), stream: true, handle })),
    aside: asideApi(run, target.grants.includes('tasks.ask'), target.track),
    transcript: transcriptApi(manifest, target.track),
    registerCommand: (id, handler) => {
      const command = manifest.contributes.commands.find((entry) => entry.id === id)
      if (command === undefined) {
        throw new Error(`${manifest.id} answers the command ${id}, which its manifest does not declare`)
      }
      const entry = { mod: manifest.id, modName: manifest.name, command }
      const answer = async (call: ModCommandCall) => forAsker(async () => run(async () => handler(call)))
      return target.track(modCommands.register({ ...entry, run: answer }))
    },
    prs: prsApi(target),
    registerHostProxy: hostProxyApi(target),
    registerWebhookSource: (id, handler) => {
      const declared = declaredSource(manifest, 'webhook', id)
      const adapter = modWebhookAdapter(manifest.name, declared, handler)
      return target.track(webhookSources.register({ info: modWebhookInfo(manifest.id, declared), adapter }))
    },
    registerPollerTemplate: (id, { script }) => {
      const { title, description } = declaredSource(manifest, 'poller', id)
      const template = { id: modScoped(manifest.id, id), mod: manifest.id, label: title, description, script }
      return target.track(pollerTemplates.register(template))
    },
    onDispose: (dispose) => {
      target.track(dispose)
    },
  }
}
