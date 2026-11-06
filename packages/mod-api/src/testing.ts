import { hostAllowed, modManifest, type ModCapability, type ModManifestInput } from '@seti/shared'
import type { ModContext, Seti, SetiFetchInit, SetiFetchResponse } from './logic.js'

/** An Error with the code Seti's host gives a refused call. */
class SetiError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface FakeSetiOptions {
  manifest: ModManifestInput
  /** What the user granted; the manifest's capabilities when left out. */
  grants?: ModCapability[]
  settings?: Record<string, unknown>
  storage?: Record<string, unknown>
  /** Answers to fetches by URL, as the fake upstream returns them. */
  fetch?: Record<string, { status?: number; body: unknown }>
}

/** What the fake recorded, for a test to assert on. */
export interface FakeRecord {
  notified: { kind: string; title: string; body: string }[]
  audited: { kind: string; summary: string }[]
  logs: string[]
  fetched: string[]
}

const denied = (what: string) => new SetiError('denied', `This mod was not granted ${what}`)

function fakeFetch(grants: readonly ModCapability[], routes: FakeSetiOptions['fetch'], record: FakeRecord) {
  return async (url: string, init: SetiFetchInit = {}): Promise<SetiFetchResponse> => {
    const parsed = new URL(url)
    const grant = grants.find((g) => (init.connection === undefined ? g.name === 'net.fetch' : g.name === 'connection'))
    const hosts = grant !== undefined && 'hosts' in grant ? grant.hosts : []
    if (parsed.protocol !== 'https:' || !hostAllowed(hosts, parsed.hostname)) {
      throw denied(`${init.connection === undefined ? 'net.fetch' : 'connection'} for ${parsed.hostname}`)
    }
    record.fetched.push(url)
    const answer = routes?.[url] ?? { status: 404, body: 'Not found' }
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)
    const status = answer.status ?? 200
    const none: [string, string][] = []
    return Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      url,
      headers: { get: () => null, has: () => false, entries: () => none },
      text: async () => Promise.resolve(text),
      json: async (): Promise<unknown> => Promise.resolve(JSON.parse(text)),
    })
  }
}

/**
 * A fake Seti for a mod's unit tests: in-memory settings and storage, a route table for fetch,
 * and Seti's refusals for capabilities not granted. Calls run in-process, not in QuickJS.
 */
export function createFakeSeti(options: FakeSetiOptions): { seti: Seti; ctx: ModContext; record: FakeRecord } {
  const manifest = modManifest.parse(options.manifest)
  const grants = options.grants ?? manifest.capabilities
  const has = (name: ModCapability['name']) => grants.some((grant) => grant.name === name)
  const store = new Map(Object.entries(options.storage ?? {}))
  const record: FakeRecord = { notified: [], audited: [], logs: [], fetched: [] }
  const needs = <T>(name: ModCapability['name'], fn: () => T): T => {
    if (!has(name)) {
      throw denied(name)
    }
    return fn()
  }
  const refuse = async (): Promise<never> => Promise.reject(denied('this call in the fake'))
  const seti: Seti = {
    settings: { get: async () => Promise.resolve({ ...options.settings }) },
    storage: {
      get: async (key) => Promise.resolve(needs('storage', () => store.get(key) ?? null)),
      keys: async (prefix = '') =>
        Promise.resolve(needs('storage', () => [...store.keys()].filter((k) => k.startsWith(prefix)))),
      set: async (key, value) => {
        needs('storage', () => store.set(key, value))
        return Promise.resolve()
      },
      delete: async (key) => {
        needs('storage', () => store.delete(key))
        return Promise.resolve()
      },
    },
    log: (...values) => {
      record.logs.push(values.map(String).join(' '))
    },
    audit: async (kind, summary) => {
      record.audited.push({ kind, summary })
      return Promise.resolve()
    },
    notify: async (kind, message) => {
      needs('notify', () => record.notified.push({ kind, ...message }))
      return Promise.resolve()
    },
    fetch: fakeFetch(grants, options.fetch, record),
    tasks: {
      list: refuse,
      get: refuse,
      transcript: refuse,
      prs: refuse,
      rename: refuse,
      pin: refuse,
      setColor: refuse,
      linkPr: refuse,
      unlinkPr: refuse,
      start: refuse,
      stop: refuse,
    },
    chat: { post: refuse },
    files: { list: refuse, read: refuse },
    statusBar: { set: async () => Promise.resolve() },
  }
  const ctx: ModContext = {
    eventId: 'test-event',
    mod: { id: manifest.id, version: manifest.version },
    caller: 'user',
  }
  return { seti, ctx, record }
}
