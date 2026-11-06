import { parentPort } from 'node:worker_threads'
import { redactSecrets } from '../scrub.js'
import { runScript } from './engine.js'
import { parseFeed } from './feed.js'
import { createPollFetch, redactValues } from './fetch.js'
import { readOutput } from './items.js'
import type { RunRequest, RunResult, WorkerMessage } from './worker-protocol.js'

/** Runs one poll; secret values are replaced before anything leaves and are not kept after it. */
async function perform(request: RunRequest): Promise<WorkerMessage> {
  const { runId } = request
  const secrets = new Map(request.secrets)
  const values = [...secrets.values()]
  const clean = (text: string) => redactSecrets(redactValues(text, values))
  try {
    const fetch = createPollFetch({ ...request.fetch, secrets })
    const outcome = await runScript(request.script, request.input, { fetch, parseFeed }, request.limits)
    const logs = outcome.logs.map(clean)
    if (!outcome.ok && outcome.aborted === true) {
      return { type: 'result', runId, result: { ok: false, error: outcome.error, logs }, retire: true }
    }
    let result: RunResult
    if (outcome.ok) {
      const value: unknown = JSON.parse(redactValues(JSON.stringify(outcome.value), values))
      const output = readOutput(value, request.fingerprintFields)
      result = 'error' in output ? { ok: false, error: output.error, logs } : { ok: true, output, logs }
    } else {
      result = { ok: false, error: clean(outcome.error), logs }
    }
    return { type: 'result', runId, result }
  } catch (e) {
    return { type: 'error', runId, error: clean(e instanceof Error ? e.message : String(e)) }
  } finally {
    secrets.clear()
    values.length = 0
    request.secrets.splice(0)
  }
}

const port = parentPort
if (port !== null) {
  port.on('message', (request: RunRequest) => {
    void perform(request).then((reply) => {
      port.postMessage(reply)
    })
  })
  port.postMessage({ type: 'ready' } satisfies WorkerMessage)
}
