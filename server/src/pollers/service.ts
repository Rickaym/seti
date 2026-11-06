import {
  CHANNEL_ACTIVITY_SHOWN,
  POLLER_LIMITS,
  type EaNoticeSeverity,
  type PollerChannelInfo,
  type PollerRun,
  type PollerRunTrigger,
  type PollerStatus,
  type PollerTestResult,
  type pollerCreateInput,
  type pollerTestInput,
  type pollerUpdateInput,
} from '@seti/shared'
import type { z } from 'zod'
import { channelHealth } from '../channels/health.js'
import { clip, eventDraft, publishEvent, routedReason } from '../channels/publish.js'
import { routeEvent } from '../channels/router.js'
import { signalTasks, subscribedTasks } from '../channels/service.js'
import { newHookId } from '../channels/signature.js'
import { POLLER_LOOPBACK, POLLER_WORKERS } from '../config.js'
import { pollerSecretValues } from '../connection-values.js'
import { now } from '../db.js'
import { HttpError } from '../http.js'
import { redactSecrets } from '../scrub.js'
import { changeKind, describeChange, diffItems, type Change } from './changes.js'
import { execute, type ExecuteDeps } from './execute.js'
import type { ReadOutput } from './items.js'
import { createPollerPool } from './pool.js'
import { createPollerScheduler, PollerBusyError } from './scheduler.js'
import { channelSubscriptions } from '../store/channel-subscriptions.js'
import { channelStore } from '../store/channels.js'
import { pollerStore, type PollerRecord } from '../store/pollers.js'
import { sandboxPolicy } from '../store/sandbox.js'

const EXCERPT_MAX = 1000

/** Every poll and test run goes through these workers, off the server's event loop. */
export const pollerWorkers = createPollerPool({
  size: POLLER_WORKERS,
  resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
  startupMs: 30_000,
})

const deps: ExecuteDeps = {
  allowedHosts: async () => (await sandboxPolicy.get()).allowed_domains,
  secretValues: pollerSecretValues,
  allowLoopback: POLLER_LOOPBACK,
  workers: pollerWorkers,
}

function statusOf(record: PollerRecord): PollerStatus {
  if (!record.enabled) {
    return 'paused'
  }
  if (record.failing) {
    return 'failing'
  }
  if (record.failures > 0) {
    return 'erroring'
  }
  return record.last_ok_at === null ? 'pending' : 'ok'
}

async function info(record: PollerRecord): Promise<PollerChannelInfo> {
  const { id, name, created_at, updated_at } = record
  return {
    source: 'poller',
    preset: 'poller',
    id,
    name,
    created_at,
    updated_at,
    poller: {
      script: record.script,
      preset: record.preset,
      interval_s: record.interval_s,
      timeout_s: record.timeout_s,
      extra_hosts: record.extra_hosts,
      secrets: record.secrets,
      fingerprint_fields: record.fingerprint_fields,
      detect_gone: record.detect_gone,
      enabled: record.enabled,
      status: statusOf(record),
      failures: record.failures,
      last_run_at: record.last_run_at,
      next_run_at: record.enabled ? record.next_run_at : null,
      baseline_at: record.baseline_at,
      keys: await pollerStore.keys(id),
      runs: await pollerStore.runs(id, CHANNEL_ACTIVITY_SHOWN),
      health: await channelHealth({ source: 'poller', ...record }),
    },
    subscriptions: await channelSubscriptions.forChannel(id),
    recent: await channelStore.recent(id, CHANNEL_ACTIVITY_SHOWN),
    deliveries: await channelStore.deliveries(id, CHANNEL_ACTIVITY_SHOWN),
  }
}

async function recordOf(id: string): Promise<PollerRecord> {
  const record = await pollerStore.get(id)
  if (record === undefined) {
    throw new HttpError(404, 'No such poller')
  }
  return record
}

interface Emitted {
  title: string
  detail: string
  url: string | null
  kind: string
  severity: EaNoticeSeverity
  excerpt: unknown
}

/** Stores one event of a run and routes it like a webhook's, with a delivery log entry. */
async function emit(record: PollerRecord, event: Emitted, key: string, at: string): Promise<boolean> {
  const fields = { source: record.name, occurred_at: at, ...event }
  const draft = eventDraft(fields, `poll:${at}:${key}`)
  const { accepted, routes } = await publishEvent(record.id, draft, { at, route: routeEvent })
  if (accepted.kind !== 'event') {
    return false
  }
  await channelStore.delivered({
    channel: record.id,
    received_at: at,
    status: 'accepted',
    http_status: 0,
    reason: routedReason(routes),
    delivery_id: clip(`poll:${key}`, 200),
    event_id: accepted.event.id,
    excerpt: clip(redactSecrets(JSON.stringify(event.excerpt)), EXCERPT_MAX),
    routes,
  })
  return true
}

function changeEvent(change: Change): Emitted {
  const described = describeChange(change)
  const item = change.type === 'gone' ? change.before : change.item
  return { ...described, kind: changeKind(change), severity: 'info', excerpt: item }
}

type RunBase = Pick<PollerRun, 'channel_id' | 'trigger' | 'due_at' | 'started_at' | 'duration_ms' | 'logs'>

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Counts a failed run and records it; subscribers hear once it has failed often enough. */
async function recordFailure(record: PollerRecord, base: RunBase, error: string): Promise<number> {
  const at = base.started_at
  const { failures, nowFailing } = await pollerStore.failed(record.id, at)
  await pollerStore.addRun({ ...base, ok: false, items: 0, emitted: 0, invalid: [], error })
  if (nowFailing) {
    const failing: Emitted = {
      title: `${record.name} is failing`,
      detail: `Its last ${String(failures)} runs failed. The latest: ${error}`,
      url: null,
      kind: 'poller_failed',
      severity: 'warning',
      excerpt: { error },
    }
    await emit(record, failing, 'poller_failed', at).catch((e: unknown) => {
      process.stderr.write(`pollers: could not tell that ${record.name} is failing: ${message(e)}\n`)
    })
  }
  return failures
}

/** Emits a successful run's changes, keeps its items and records it. */
async function recordSuccess(record: PollerRecord, base: RunBase, output: ReadOutput): Promise<void> {
  const { id } = record
  const at = base.started_at
  const { items, invalid, complete, state } = output
  const seen = await pollerStore.seen(id)
  const changes = diffItems(seen, items, {
    baseline: record.baseline_at === null,
    detectGone: record.detect_gone,
    complete,
  })
  let emitted = 0
  if (record.failing) {
    const recovered: Emitted = {
      title: `${record.name} works again`,
      detail: `A run succeeded after ${String(record.failures)} failed ones.`,
      url: null,
      kind: 'poller_recovered',
      severity: 'success',
      excerpt: { items: items.length },
    }
    emitted += Number(await emit(record, recovered, 'poller_recovered', at))
  }
  for (const change of changes) {
    const key = change.type === 'gone' ? change.before.key : change.item.key
    emitted += Number(await emit(record, changeEvent(change), `${change.type}:${key}`, at))
  }
  const gone = changes.flatMap((change) => (change.type === 'gone' ? [change.before.key] : []))
  await pollerStore.succeeded(id, { at, items, gone, state })
  await pollerStore.addRun({ ...base, ok: true, items: items.length, emitted, invalid, error: null })
}

/**
 * Runs a poller once and reports what changed; resolves with its failures in a row, or null when
 * Seti stopped it while shutting down: that records nothing, so it runs again after the restart.
 */
export async function runPoller(
  id: string,
  trigger: PollerRunTrigger,
  dueAt: string | null = null,
): Promise<number | null> {
  const record = await pollerStore.get(id)
  if (record === undefined) {
    return 0
  }
  const at = now()
  const run = await execute(record, { state: record.state, since: record.last_ok_at }, deps)
  const { duration_ms: durationMs, logs } = run
  const base: RunBase = { channel_id: id, trigger, due_at: dueAt, started_at: at, duration_ms: durationMs, logs }
  if (!run.ok) {
    return run.interrupted === true ? null : recordFailure(record, base, run.error)
  }
  try {
    await recordSuccess(record, base, run.output)
    return 0
  } catch (e) {
    return recordFailure(record, base, `Seti could not finish the run: ${message(e)}`)
  }
}

export const pollerScheduler = createPollerScheduler({
  list: async () => pollerStore.list(),
  get: async (id) => pollerStore.get(id),
  run: runPoller,
  setNextRun: async (id, at) => pollerStore.setNextRun(id, at),
  concurrency: POLLER_LIMITS.concurrentRuns,
  onError: (e) => {
    process.stderr.write(`pollers: ${message(e)}\n`)
  },
  onStale: (id, reason) => {
    process.stderr.write(`pollers: re-armed poller ${id} because ${reason}\n`)
  },
})

/** Poller channels: create, change, pause, delete, poll now and test run them. */
export const pollers = {
  list: async (): Promise<PollerChannelInfo[]> =>
    Promise.all((await pollerStore.list()).map(async (record) => info(record))),
  get: async (id: string): Promise<PollerRecord> => recordOf(id),
  info: async (id: string): Promise<PollerChannelInfo> => info(await recordOf(id)),
  /** A poller's newest runs, more than its info lists. */
  runs: async (id: string, limit: number): Promise<PollerRun[]> => pollerStore.runs((await recordOf(id)).id, limit),
  create: async (input: z.output<typeof pollerCreateInput>): Promise<PollerChannelInfo> => {
    const { name, subscribe_ea: subscribeEa, ...settings } = input
    const record = await pollerStore.create(newHookId(), name, settings, now())
    if (subscribeEa) {
      await channelSubscriptions.add({
        channel_id: record.id,
        target: 'ea',
        task_id: null,
        events: null,
        created_at: now(),
      })
    }
    await pollerScheduler.sync(record.id)
    return info((await pollerStore.get(record.id)) ?? record)
  },
  update: async (id: string, change: z.output<typeof pollerUpdateInput>): Promise<PollerChannelInfo> => {
    const current = await recordOf(id)
    const updated = (await pollerStore.update(id, change, now())) ?? current
    if (updated.name !== current.name) {
      signalTasks(await subscribedTasks(id))
    }
    if (updated.enabled !== current.enabled || updated.interval_s !== current.interval_s) {
      await pollerScheduler.sync(id)
    }
    return info((await pollerStore.get(id)) ?? updated)
  },
  remove: async (id: string): Promise<PollerRecord> => {
    const current = await recordOf(id)
    const taskIds = await subscribedTasks(id)
    await channelStore.remove(id)
    await pollerScheduler.sync(id)
    signalTasks(taskIds)
    return current
  },
  pollNow: async (id: string): Promise<PollerChannelInfo> => {
    await recordOf(id)
    try {
      await pollerScheduler.pollNow(id)
    } catch (e) {
      if (e instanceof PollerBusyError) {
        throw new HttpError(409, e.message)
      }
      throw e
    }
    return info(await recordOf(id))
  },
  /** Runs the settings as given once, with the saved poller's state if named; stores nothing. */
  test: async (input: z.output<typeof pollerTestInput>): Promise<PollerTestResult> => {
    const saved = input.channel_id === undefined ? undefined : await recordOf(input.channel_id)
    const stored = saved?.state ?? null
    const run = await pollerScheduler.withSlot(async () =>
      execute(input, { state: stored, since: saved?.last_ok_at ?? null }, deps),
    )
    if (!run.ok) {
      const failed = { ok: false, error: run.error, items: [], invalid: [], logs: run.logs, state: stored }
      return { ...failed, duration_ms: run.duration_ms }
    }
    const { items, invalid, state } = run.output
    const kept = state === undefined ? stored : state
    return { ok: true, error: null, items, invalid, logs: run.logs, duration_ms: run.duration_ms, state: kept }
  },
}
