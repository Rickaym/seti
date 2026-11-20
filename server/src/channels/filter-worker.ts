import { parentPort } from 'node:worker_threads'
import type { FilterReply, FilterRequest } from './filter-protocol.js'
import { runModule, type ModuleEntry } from '../quickjs/engine.js'
import type { PoolMessage } from '../quickjs/pool.js'

/** Calls the filter with the event and a log function, and says what type it returned. */
const PRELUDE = `(host, input, filter) => {
  const log = (...values) => {
    host.log(values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' '))
  }
  const kind = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)
  return Promise.resolve(filter(JSON.parse(input), Object.freeze({ log }))).then((value) => ({
    kind: kind(value),
    value: value === undefined ? null : value,
  }))
}`

const FILTER: ModuleEntry = {
  file: 'filter.js',
  prelude: PRELUDE,
  main: { type: 'function', missing: 'Export the filter function: export default function filter(event) { ... }' },
}

type Message = PoolMessage<FilterReply>

/** Runs one filter in a fresh engine with no host functions but log. */
async function perform(request: FilterRequest): Promise<Message> {
  const runId = request.runId ?? 0
  try {
    const outcome = await runModule({
      script: request.script,
      entry: FILTER,
      input: request.input,
      host: {},
      limits: request.limits,
    })
    if (outcome.ok) {
      return { type: 'result', runId, result: { ok: true, value: outcome.value, logs: outcome.logs } }
    }
    const result: FilterReply = { ok: false, error: outcome.error, logs: outcome.logs }
    return outcome.aborted === true
      ? { type: 'result', runId, result, retire: true }
      : { type: 'result', runId, result }
  } catch (e) {
    return { type: 'error', runId, error: e instanceof Error ? e.message : String(e) }
  }
}

const port = parentPort
if (port !== null) {
  port.on('message', (request: FilterRequest) => {
    void perform(request).then((reply) => {
      port.postMessage(reply)
    })
  })
  port.postMessage({ type: 'ready' } satisfies Message)
}
