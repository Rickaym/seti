import { runModule, type ModuleEntry, type ModuleLimits } from '../quickjs/engine.js'

/** What the script may call on the host; each takes and returns plain JSON-safe values. */
export interface EngineHost {
  fetch: (request: unknown, signal: AbortSignal) => Promise<EngineResponse>
  parseFeed: (text: string) => unknown
}

export interface EngineLimits extends ModuleLimits {
  fetches: number
}

export interface EngineInput {
  state: unknown
  since: string | null
}

/** `aborted` means the engine itself failed; its thread should not run another script. */
export type EngineOutcome =
  { ok: true; value: unknown; logs: string[] } | { ok: false; error: string; logs: string[]; aborted?: true }

interface EngineResponse {
  status: number
  url: string
  headers: [string, string][]
  body: string
}

/** Wraps the host functions in the small API the poll function receives. */
const PRELUDE = `(host, input) => {
  const headers = (pairs) => {
    const map = new Map(pairs)
    const key = (name) => String(name).toLowerCase()
    return Object.freeze({
      get: (name) => map.get(key(name)) ?? null,
      has: (name) => map.has(key(name)),
      entries: () => [...map.entries()],
    })
  }
  const fetch = async (url, init) => {
    const raw = await host.fetch(JSON.stringify({ url: String(url), init: init ?? {} }))
    return Object.freeze({
      status: raw.status,
      ok: raw.status >= 200 && raw.status < 300,
      url: raw.url,
      headers: headers(JSON.parse(raw.headers)),
      text: async () => raw.body,
      json: async () => JSON.parse(raw.body),
    })
  }
  const parseFeed = (text) => JSON.parse(host.parseFeed(String(text)))
  const log = (...values) => {
    host.log(values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' '))
  }
  return { fetch, parseFeed, log, ...JSON.parse(input) }
}`

const POLLER: ModuleEntry = {
  file: 'poller.js',
  prelude: `(host, input, poll) => poll((${PRELUDE})(host, input))`,
  main: { type: 'function', missing: 'Export the poll function: export default async function poll(api) { ... }' },
}

/** Runs a poll script in a fresh QuickJS instance that has only the host API it is given. */
export async function runScript(
  script: string,
  input: EngineInput,
  host: EngineHost,
  limits: EngineLimits,
): Promise<EngineOutcome> {
  let fetches = 0
  const fetch = async (text: string, signal: AbortSignal) => {
    fetches += 1
    if (fetches > limits.fetches) {
      throw new Error(`A run makes at most ${String(limits.fetches)} requests`)
    }
    const response = await host.fetch(JSON.parse(text), signal)
    return {
      status: response.status,
      url: response.url,
      headers: JSON.stringify(response.headers),
      body: response.body,
    }
  }
  const outcome = await runModule({
    script,
    entry: POLLER,
    input,
    host: {
      fetch: { kind: 'async', call: fetch },
      parseFeed: { kind: 'sync', call: (text) => JSON.stringify(host.parseFeed(text)) },
    },
    limits,
  })
  if (outcome.ok) {
    return { ok: true, value: outcome.value, logs: outcome.logs }
  }
  return outcome.aborted === true
    ? { ok: false, error: outcome.error, logs: outcome.logs, aborted: true }
    : { ok: false, error: outcome.error, logs: outcome.logs }
}
