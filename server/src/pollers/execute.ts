import { POLLER_LIMITS, type PollerSettings } from '@seti/shared'
import { redactSecrets } from '../scrub.js'
import { redactValues } from './fetch.js'
import type { ReadOutput } from './items.js'
import { PoolClosedError, type PollerPool } from './pool.js'

export interface ExecuteDeps {
  /** The sandbox allowlist, which every poller may reach besides its own extra hosts. */
  allowedHosts: () => Promise<readonly string[]>
  /** The values of the secrets a poller names; throws when one is not set. */
  secretValues: (refs: readonly string[]) => Promise<Map<string, string>>
  allowLoopback: boolean
  workers: Pick<PollerPool, 'run'>
}

export type Execution =
  | { ok: true; output: ReadOutput; logs: string[]; duration_ms: number }
  | { ok: false; error: string; logs: string[]; duration_ms: number; interrupted?: true }

export interface ExecuteContext {
  state: unknown
  since: string | null
}

const REQUEST_TIMEOUT_MS = 15_000
/** How long past its timeout the worker gets to stop the script before Seti stops the worker. */
const WALL_GRACE_MS = 2000

type Settings = Pick<PollerSettings, 'script' | 'timeout_s' | 'extra_hosts' | 'secrets' | 'fingerprint_fields'>

/** Runs a poller's script once in a worker and checks its output; stores and reports nothing. */
export async function execute(settings: Settings, context: ExecuteContext, deps: ExecuteDeps): Promise<Execution> {
  const started = Date.now()
  const elapsed = () => Date.now() - started
  let values: string[] = []
  const clean = (text: string) => redactSecrets(redactValues(text, values))
  try {
    const secrets = await deps.secretValues(settings.secrets)
    values = [...secrets.values()]
    const timeoutMs = settings.timeout_s * 1000
    const result = await deps.workers.run(
      {
        script: settings.script,
        input: { state: context.state, since: context.since },
        limits: {
          timeoutMs,
          memoryBytes: POLLER_LIMITS.memoryMb * 1024 * 1024,
          cpuSliceMs: POLLER_LIMITS.cpuSliceMs,
          cpuTotalMs: POLLER_LIMITS.cpuTotalMs,
          fetches: POLLER_LIMITS.fetchesPerRun,
          logLines: POLLER_LIMITS.logLines,
          logLineChars: POLLER_LIMITS.logLineChars,
          outputBytes: POLLER_LIMITS.outputMaxBytes,
        },
        fetch: {
          allowed: [...(await deps.allowedHosts()), ...settings.extra_hosts],
          responseMaxBytes: POLLER_LIMITS.responseMaxBytes,
          runResponseMaxBytes: POLLER_LIMITS.runResponseMaxBytes,
          requestBodyMaxBytes: POLLER_LIMITS.requestBodyMaxBytes,
          timeoutMs: Math.min(REQUEST_TIMEOUT_MS, timeoutMs),
          allowLoopback: deps.allowLoopback,
        },
        fingerprintFields: settings.fingerprint_fields,
        secrets: [...secrets],
      },
      timeoutMs + WALL_GRACE_MS,
    )
    return { ...result, duration_ms: elapsed() }
  } catch (e) {
    const error = clean(e instanceof Error ? e.message : String(e))
    const interrupted = e instanceof PoolClosedError ? { interrupted: true as const } : {}
    return { ok: false, error, logs: [], duration_ms: elapsed(), ...interrupted }
  }
}
