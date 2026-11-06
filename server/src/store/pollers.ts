import {
  CHANNEL_RUN_HISTORY_DAYS,
  POLLER_LIMITS,
  type PollerChange,
  type PollerItem,
  type PollerRun,
  type PollerSettings,
} from '@seti/shared'
import { sql, transaction } from '../db.js'
import type { SeenItem } from '../pollers/changes.js'

/** A poller channel with its settings and where its runs stand. */
export interface PollerRecord extends PollerSettings {
  id: string
  name: string
  created_at: string
  updated_at: string
  /** The JSON the script keeps between runs; null before it keeps any. */
  state: unknown
  failures: number
  /** Whether subscribers were told it is failing, so they hear once when it recovers. */
  failing: boolean
  baseline_at: string | null
  last_run_at: string | null
  last_ok_at: string | null
  next_run_at: string | null
}

interface Row {
  id: string
  name: string
  created_at: string
  updated_at: string
  script: string
  preset: string
  interval_s: number
  timeout_s: number
  extra_hosts: string
  secrets: string
  fingerprint_fields: string
  detect_gone: boolean
  enabled: boolean
  state: string | null
  failures: number
  failing: boolean
  baseline_at: string | null
  last_run_at: string | null
  last_ok_at: string | null
  next_run_at: string | null
}

const strings = (text: string): string[] => {
  const parsed: unknown = JSON.parse(text)
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
}

function toRecord(row: Row): PollerRecord {
  return {
    ...row,
    extra_hosts: strings(row.extra_hosts),
    secrets: strings(row.secrets),
    fingerprint_fields: strings(row.fingerprint_fields),
    state: row.state === null ? null : (JSON.parse(row.state) as unknown),
  }
}

const SELECT = sql`SELECT c.id, c.name, c.created_at, c.updated_at, p.script, p.preset, p.interval_s,
    p.timeout_s, p.extra_hosts, p.secrets, p.fingerprint_fields, p.detect_gone, p.enabled, p.state, p.failures, p.failing,
    p.baseline_at, p.last_run_at, p.last_ok_at, p.next_run_at
  FROM channel c JOIN channel_poller p ON p.channel_id = c.id`

type RunRow = Omit<PollerRun, 'invalid' | 'logs'> & { invalid: string; logs: string }

export type NewRun = Omit<PollerRun, 'id'>

/** What a successful run leaves behind. */
export interface RunSuccess {
  at: string
  items: readonly PollerItem[]
  gone: readonly string[]
  /** Undefined keeps the stored state. */
  state: unknown
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Runs started before this are dropped; the newest runsKept keep their logs too. */
export const historyStart = (at: string) => new Date(Date.parse(at) - CHANNEL_RUN_HISTORY_DAYS * DAY_MS).toISOString()

/** Poller channels, the items they saw and their runs. */
export const pollerStore = {
  /** Names of the pollers that send a connection or GitHub token, by its reference. */
  usingSecret: async (secret: string): Promise<string[]> =>
    (
      await sql<{ name: string }[]>`SELECT c.name FROM channel_poller p JOIN channel c ON c.id = p.channel_id
        WHERE p.secrets::jsonb ? ${secret} ORDER BY c.name`
    ).map((row) => row.name),
  list: async (): Promise<PollerRecord[]> => (await sql<Row[]>`${SELECT} ORDER BY c.created_at, c.id`).map(toRecord),
  get: async (id: string): Promise<PollerRecord | undefined> => {
    const [row] = await sql<Row[]>`${SELECT} WHERE c.id = ${id}`
    return row && toRecord(row)
  },
  create: async (id: string, name: string, settings: PollerSettings, at: string): Promise<PollerRecord> => {
    await transaction(async (tx) => {
      await tx`INSERT INTO channel (id, name, preset, secret, mapping, created_at, updated_at, source)
        VALUES (${id}, ${name}, 'poller', NULL, '{}', ${at}, ${at}, 'poller')`
      await tx`INSERT INTO channel_poller (channel_id, script, preset, interval_s, timeout_s, extra_hosts, secrets,
          fingerprint_fields, detect_gone, enabled)
        VALUES (${id}, ${settings.script}, ${settings.preset}, ${settings.interval_s}, ${settings.timeout_s},
          ${JSON.stringify(settings.extra_hosts)}, ${JSON.stringify(settings.secrets)},
          ${JSON.stringify(settings.fingerprint_fields)}, ${settings.detect_gone}, ${settings.enabled})`
    })
    const created = await pollerStore.get(id)
    if (created === undefined) {
      throw new Error('Poller was not created')
    }
    return created
  },
  update: async (id: string, change: PollerChange, at: string): Promise<PollerRecord | undefined> => {
    const json = (value: readonly string[] | undefined) => (value === undefined ? null : JSON.stringify(value))
    await transaction(async (tx) => {
      await tx`UPDATE channel SET name = COALESCE(${change.name ?? null}, name), updated_at = ${at}
        WHERE id = ${id} AND source = 'poller'`
      await tx`UPDATE channel_poller SET script = COALESCE(${change.script ?? null}, script),
          preset = COALESCE(${change.preset ?? null}, preset),
          interval_s = COALESCE(${change.interval_s ?? null}::integer, interval_s),
          timeout_s = COALESCE(${change.timeout_s ?? null}::integer, timeout_s),
          extra_hosts = COALESCE(${json(change.extra_hosts)}, extra_hosts),
          secrets = COALESCE(${json(change.secrets)}, secrets),
          fingerprint_fields = COALESCE(${json(change.fingerprint_fields)}, fingerprint_fields),
          detect_gone = COALESCE(${change.detect_gone ?? null}::boolean, detect_gone),
          enabled = COALESCE(${change.enabled ?? null}::boolean, enabled)
        WHERE channel_id = ${id}`
    })
    return pollerStore.get(id)
  },
  setNextRun: async (id: string, at: string | null): Promise<void> => {
    await sql`UPDATE channel_poller SET next_run_at = ${at} WHERE channel_id = ${id}`
  },
  /** The items the poller saw in the last 30 days, by key. */
  seen: async (id: string): Promise<Map<string, SeenItem>> => {
    const rows = await sql<(Omit<SeenItem, 'fields'> & { fields: string })[]>`SELECT key, fingerprint, kind, title,
        url, fields FROM channel_poller_item WHERE channel_id = ${id}`
    return new Map(rows.map((row) => [row.key, { ...row, fields: JSON.parse(row.fields) as Record<string, unknown> }]))
  },
  keys: async (id: string): Promise<number> => {
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::integer AS n FROM channel_poller_item
      WHERE channel_id = ${id}`
    return row?.n ?? 0
  },
  /** Keeps the run's items, drops gone and stale ones, and marks the poller healthy. */
  succeeded: async (id: string, run: RunSuccess): Promise<void> => {
    const stale = new Date(Date.parse(run.at) - POLLER_LIMITS.keysKeptDays * DAY_MS).toISOString()
    await transaction(async (tx) => {
      for (const item of run.items) {
        await tx`INSERT INTO channel_poller_item (channel_id, key, fingerprint, kind, title, url, fields,
            first_seen, last_seen)
          VALUES (${id}, ${item.key}, ${item.fingerprint}, ${item.kind}, ${item.title}, ${item.url},
            ${JSON.stringify(item.fields)}, ${run.at}, ${run.at})
          ON CONFLICT (channel_id, key) DO UPDATE SET fingerprint = excluded.fingerprint, kind = excluded.kind,
            title = excluded.title, url = excluded.url, fields = excluded.fields, last_seen = excluded.last_seen`
      }
      if (run.gone.length > 0) {
        await tx`DELETE FROM channel_poller_item WHERE channel_id = ${id} AND key IN ${tx(run.gone)}`
      }
      await tx`DELETE FROM channel_poller_item WHERE channel_id = ${id} AND last_seen < ${stale}`
      await tx`DELETE FROM channel_poller_item WHERE channel_id = ${id} AND key NOT IN (
          SELECT key FROM channel_poller_item WHERE channel_id = ${id}
          ORDER BY last_seen DESC, key LIMIT ${POLLER_LIMITS.keysKept})`
      const state = run.state === undefined ? null : JSON.stringify(run.state)
      await tx`UPDATE channel_poller SET failures = 0, failing = false, last_run_at = ${run.at},
          last_ok_at = ${run.at}, baseline_at = COALESCE(baseline_at, ${run.at}),
          state = COALESCE(${state}, state)
        WHERE channel_id = ${id}`
    })
  },
  /** Counts a failed run; returns the failures in a row, and whether this one made it failing. */
  failed: async (id: string, at: string): Promise<{ failures: number; nowFailing: boolean }> => {
    const [row] = await sql<{ failures: number; was: boolean }[]>`UPDATE channel_poller p
      SET failures = p.failures + 1, last_run_at = ${at},
        failing = p.failing OR p.failures + 1 >= ${POLLER_LIMITS.failuresBeforeFailing}
      FROM (SELECT failing AS was FROM channel_poller WHERE channel_id = ${id}) old
      WHERE p.channel_id = ${id} RETURNING p.failures, old.was`
    const failures = row?.failures ?? 0
    return { failures, nowFailing: row?.was === false && failures >= POLLER_LIMITS.failuresBeforeFailing }
  },
  addRun: async (run: NewRun): Promise<PollerRun> => {
    const [row] = await sql<RunRow[]>`INSERT INTO channel_poller_run (channel_id, trigger, due_at, started_at,
        duration_ms, ok, items, emitted, invalid, error, logs)
      VALUES (${run.channel_id}, ${run.trigger}, ${run.due_at}, ${run.started_at}, ${run.duration_ms}, ${run.ok},
        ${run.items}, ${run.emitted}, ${JSON.stringify(run.invalid)}, ${run.error}, ${JSON.stringify(run.logs)})
      RETURNING *`
    await sql`DELETE FROM channel_poller_run WHERE channel_id = ${run.channel_id}
      AND started_at < ${historyStart(run.started_at)}`
    await sql`UPDATE channel_poller_run SET logs = '[]', invalid = '[]' WHERE id = (
        SELECT id FROM channel_poller_run WHERE channel_id = ${run.channel_id}
        ORDER BY id DESC OFFSET ${POLLER_LIMITS.runsKept} LIMIT 1) AND (logs <> '[]' OR invalid <> '[]')`
    if (row === undefined) {
      throw new Error('Run was not recorded')
    }
    return { ...row, invalid: strings(row.invalid), logs: strings(row.logs) }
  },
  runs: async (id: string, limit: number): Promise<PollerRun[]> =>
    (
      await sql<RunRow[]>`SELECT * FROM channel_poller_run WHERE channel_id = ${id} ORDER BY id DESC LIMIT ${limit}`
    ).map((row) => ({ ...row, invalid: strings(row.invalid), logs: strings(row.logs) })),
}
