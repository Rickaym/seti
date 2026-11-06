import {
  pollerCreateInput,
  pollerTestInput,
  pollerUpdateInput,
  type PollerChannelInfo,
  type PollerRun,
} from '@seti/shared'
import { z } from 'zod'
import { findPoller, pollerRef, subscriberView } from './channel-refs.js'
import { setiTool, ToolRefusal } from './tool.js'
import { createPoller, testPoller, updatePoller } from '../pollers/actions.js'

const SCRIPT_SHOWN = 3000
const MINUTE_S = 60

const SCRIPT_API =
  'A JavaScript module Seti runs in an isolated engine, with no Node, files, processes or CLIs: export ' +
  'default async function poll({ fetch, parseFeed, log, state, since }) returning an array of items, or ' +
  '{ items, state } to keep a small JSON state. An item has key (required and stable), and optionally ' +
  'title, kind, url, body, fields (an object) and fingerprint. fetch(url, init) reaches only hosts on the ' +
  "sandbox allowlist plus the poller's extra hosts. parseFeed(text) reads RSS or Atom. log(...) keeps a line " +
  'in the run log. The first run only records what is there; later runs report new keys, changed items ' +
  'and, with detect_gone, keys that went missing.'

const script = z.string().min(1).describe(SCRIPT_API)
const intervalMinutes = z.number().int().min(1).max(1440).optional().describe('Minutes between runs; default 5.')
const timeoutSeconds = pollerUpdateInput.shape.timeout_s.describe('Seconds a run may take; default 30.')
const fingerprintFields = pollerUpdateInput.shape.fingerprint_fields.describe(
  'Fields that decide whether an item changed; empty uses the whole item.',
)
const detectGone = pollerUpdateInput.shape.detect_gone.describe('Report items a run no longer returns.')

export const pollerRunView = ({
  trigger,
  started_at,
  duration_ms,
  ok,
  items,
  emitted,
  invalid,
  error,
  logs,
}: PollerRun) => ({
  trigger,
  started_at,
  duration_ms,
  ok,
  items,
  emitted,
  ...(invalid.length === 0 ? {} : { invalid }),
  ...(error === null ? {} : { error }),
  ...(logs.length === 0 ? {} : { logs: logs.slice(0, 5) }),
})

/** A poller as an agent needs it; extra hosts and secrets show by name, never by value. */
export const pollerView = (info: PollerChannelInfo, withScript = true) => {
  const { poller } = info
  return {
    id: info.id,
    name: info.name,
    source: info.source,
    status: poller.status,
    enabled: poller.enabled,
    interval_s: poller.interval_s,
    timeout_s: poller.timeout_s,
    extra_hosts: poller.extra_hosts,
    secrets: poller.secrets,
    fingerprint_fields: poller.fingerprint_fields,
    detect_gone: poller.detect_gone,
    failures: poller.failures,
    last_run_at: poller.last_run_at,
    next_run_at: poller.next_run_at,
    keys: poller.keys,
    subscribers: info.subscriptions.map(subscriberView),
    ...(withScript ? { script: poller.script.slice(0, SCRIPT_SHOWN) } : {}),
    latest_runs: poller.runs.slice(0, withScript ? 3 : 1).map(pollerRunView),
  }
}

const createPollerTool = setiTool({
  name: 'create_poller',
  description:
    'Create a poller: a channel for a service without webhooks, such as a JSON API or an RSS feed. Seti runs ' +
    'its script on a schedule without a model and reports what changed to its subscribers, like a webhook. ' +
    'Try the script with test_channel_script first. Only the user gives a poller extra hosts or secrets.',
  input: {
    name: pollerCreateInput.shape.name,
    script,
    interval_minutes: intervalMinutes,
    timeout_seconds: timeoutSeconds,
    fingerprint_fields: fingerprintFields,
    detect_gone: detectGone,
    subscribe_ea: pollerCreateInput.shape.subscribe_ea.describe("Also send its events to the EA's inbox."),
  },
  run: async (args) => {
    const input = pollerCreateInput.parse({
      name: args.name,
      script: args.script,
      subscribe_ea: args.subscribe_ea,
      ...(args.interval_minutes === undefined ? {} : { interval_s: args.interval_minutes * MINUTE_S }),
      ...(args.timeout_seconds === undefined ? {} : { timeout_s: args.timeout_seconds }),
      ...(args.fingerprint_fields === undefined ? {} : { fingerprint_fields: args.fingerprint_fields }),
      ...(args.detect_gone === undefined ? {} : { detect_gone: args.detect_gone }),
    })
    return pollerView(await createPoller(input))
  },
})

const updatePollerTool = setiTool({
  name: 'update_poller',
  description:
    'Change a poller: its name, script, schedule or change detection, or pause and resume it. Only the user ' +
    'changes its extra hosts or secrets, or the script of a poller that uses secrets.',
  input: {
    poller: pollerRef,
    name: pollerUpdateInput.shape.name,
    script: script.optional().describe(`The whole new script. ${SCRIPT_API}`),
    interval_minutes: intervalMinutes,
    timeout_seconds: timeoutSeconds,
    fingerprint_fields: fingerprintFields,
    detect_gone: detectGone,
    active: z.boolean().optional().describe('false pauses it, true resumes it.'),
  },
  run: async ({ poller, active, interval_minutes: minutes, timeout_seconds: timeout, ...rest }) => {
    const info = await findPoller(poller)
    const change = pollerUpdateInput.parse({
      ...rest,
      ...(active === undefined ? {} : { enabled: active }),
      ...(minutes === undefined ? {} : { interval_s: minutes * MINUTE_S }),
      ...(timeout === undefined ? {} : { timeout_s: timeout }),
    })
    return pollerView(await updatePoller(info.id, change))
  },
})

/** A test run of a poller script: a draft, a saved poller, or a new script for a saved poller. */
export async function testPollerScript(draft: string | undefined, saved: PollerChannelInfo | null) {
  if (saved === null && draft === undefined) {
    throw new ToolRefusal('Give a script to test, or a poller.')
  }
  const settings =
    saved === null
      ? {}
      : {
          channel_id: saved.id,
          script: saved.poller.script,
          timeout_s: saved.poller.timeout_s,
          extra_hosts: saved.poller.extra_hosts,
          secrets: saved.poller.secrets,
          fingerprint_fields: saved.poller.fingerprint_fields,
        }
  return testPoller(pollerTestInput.parse({ ...settings, ...(draft === undefined ? {} : { script: draft }) }))
}

export const POLLER_TOOLS = [createPollerTool, updatePollerTool]
