import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  query,
  type McpServerStatus,
  type McpServerStatusConfig,
  type SdkPluginConfig,
  type SDKControlInitializeResponse,
  type SDKUserMessage,
  type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk'
import {
  mcpSignIn,
  type CapabilitiesSnapshot,
  type CommandGroup,
  type CommandInfo,
  type McpServer,
  type McpTransport,
} from '@seti/shared'
import { PROBE_DELAY_MS } from './config.js'
import { cache } from './redis.js'

/** The slice of an SDK Query the probe uses, so tests can inject a fake. */
export interface ProbeSession {
  initializationResult: () => Promise<SDKControlInitializeResponse>
  mcpServerStatus: () => Promise<McpServerStatus[]>
  close: () => void
}

export type StartProbe = (cwd: string, signal: AbortSignal) => ProbeSession

export interface ProbeTiming {
  pollMs: number
  pendingCapMs: number
  callTimeoutMs: number
}

const DEFAULT_TIMING: ProbeTiming = { pollMs: 1000, pendingCapMs: 20_000, callTimeoutMs: 30_000 }

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g

/** Origin and path only: drops credentials, query string and fragment. */
export function safeUrl(raw: string): string | null {
  if (!URL.canParse(raw)) {
    return null
  }
  const url = new URL(raw)
  return url.origin === 'null' ? `${url.protocol}//${url.host}${url.pathname}` : `${url.origin}${url.pathname}`
}

export const scrubUrls = (text: string) => text.replace(URL_PATTERN, (match) => safeUrl(match) ?? '[url]')

export function describeTransport(config: McpServerStatusConfig | undefined): McpTransport | null {
  if (config === undefined) {
    return null
  }
  if (config.type === undefined || config.type === 'stdio') {
    return { type: 'stdio', target: path.basename(config.command) }
  }
  switch (config.type) {
    case 'sse':
    case 'http':
    case 'claudeai-proxy':
      return { type: config.type, target: safeUrl(config.url) }
    case 'sdk':
      return { type: 'sdk', target: config.name }
  }
}

export function toServer(status: McpServerStatus): McpServer {
  const transport = describeTransport(status.config)
  const facts = { status: status.status, transport: transport?.type ?? null, clientId: false, tokenStored: false }
  return {
    name: status.name,
    status: status.status,
    scope: status.scope ?? null,
    source: status.source ?? null,
    transport,
    connector_id: status.config?.type === 'claudeai-proxy' ? status.config.id : null,
    server_version: status.serverInfo ? `${status.serverInfo.name} ${status.serverInfo.version}` : null,
    error: status.error === undefined ? null : scrubUrls(status.error),
    tools: (status.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      read_only: tool.annotations?.readOnly === true,
      destructive: tool.annotations?.destructive === true,
      open_world: tool.annotations?.openWorld === true,
    })),
    sign_in: mcpSignIn(facts).sign_in,
  }
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)

const toCommand = (command: SlashCommand): CommandInfo => ({
  name: command.name,
  description: command.description,
  argument_hint: command.argumentHint,
  aliases: command.aliases ?? [],
})

/** Groups non-builtin commands by the prefix before ':'; unprefixed ones sort first. */
export function groupCommands(commands: SlashCommand[]): {
  skill_groups: CommandGroup[]
  builtin_commands: CommandInfo[]
} {
  const groups = new Map<string | null, CommandInfo[]>()
  const builtin: CommandInfo[] = []
  for (const command of commands) {
    if (command.builtin === true) {
      builtin.push(toCommand(command))
      continue
    }
    const colon = command.name.indexOf(':')
    const prefix = colon > 0 ? command.name.slice(0, colon) : null
    groups.set(prefix, [...(groups.get(prefix) ?? []), toCommand(command)])
  }
  const skill_groups = [...groups.entries()]
    .map(([prefix, items]) => ({ prefix, commands: items.toSorted(byName) }))
    .toSorted((a, b) => (a.prefix ?? '').localeCompare(b.prefix ?? ''))
  return { skill_groups, builtin_commands: builtin.toSorted(byName) }
}

function buildSnapshot(
  cwd: string,
  init: SDKControlInitializeResponse,
  servers: McpServerStatus[],
  timing: { startedAt: number; pendingTimedOut: boolean },
): CapabilitiesSnapshot {
  return {
    cwd,
    probed_at: new Date().toISOString(),
    duration_ms: Date.now() - timing.startedAt,
    pending_timed_out: timing.pendingTimedOut,
    account: {
      email: init.account.email ?? null,
      organization: init.account.organization ?? null,
      subscription_type: init.account.subscriptionType ?? null,
      api_provider: init.account.apiProvider ?? null,
    },
    servers: servers.map(toServer).sort(byName),
    ...groupCommands(init.commands),
    subagents: init.agents
      .map((agent) => ({ name: agent.name, description: agent.description, model: agent.model ?? null }))
      .sort(byName),
    models: init.models.map((model) => ({
      value: model.value,
      display_name: model.displayName,
      description: model.description,
    })),
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${String(ms)} ms waiting for ${what}`))
    }, ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

const sleep = async (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const hasPending = (servers: McpServerStatus[]) => servers.some((server) => server.status === 'pending')

/** Starts a session that never sends a prompt, reads its init result and polls MCP status. */
export async function probe(
  cwd: string,
  start: StartProbe,
  timing: ProbeTiming = DEFAULT_TIMING,
): Promise<CapabilitiesSnapshot> {
  const startedAt = Date.now()
  const abort = new AbortController()
  const session = start(cwd, abort.signal)
  try {
    const init = await withTimeout(session.initializationResult(), timing.callTimeoutMs, 'Claude Code to start')
    const status = async () => withTimeout(session.mcpServerStatus(), timing.callTimeoutMs, 'MCP server status')
    const deadline = startedAt + timing.pendingCapMs
    let servers = await status()
    while (hasPending(servers) && Date.now() < deadline) {
      await sleep(timing.pollMs)
      servers = await status()
    }
    return buildSnapshot(cwd, init, servers, { startedAt, pendingTimedOut: hasPending(servers) })
  } finally {
    abort.abort()
    session.close()
  }
}

export function idlePrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  const done = new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
    signal.addEventListener('abort', () => {
      resolve({ done: true, value: undefined })
    })
  })
  return { [Symbol.asyncIterator]: () => ({ next: async () => done }) }
}

export function probeEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ANTHROPIC_API_KEY') {
      env[key] = value
    }
  }
  return env
}

let probePlugins: () => Promise<SdkPluginConfig[]> = async () => Promise.resolve([])
/** Read before each probe, since starting a probe cannot wait. */
let loadedPlugins: SdkPluginConfig[] = []

/** Sets the local plugins every probe loads, so Capabilities matches what a new task gets. */
export function setProbePlugins(provider: () => Promise<SdkPluginConfig[]>): void {
  probePlugins = provider
}

let afterProbe: () => void = () => undefined

/** Runs after every probe that finishes, which is when Seti rereads the MCP config. */
export function setAfterProbe(listener: () => void): void {
  afterProbe = listener
}

const startSdkProbe: StartProbe = (cwd, signal) =>
  query({
    prompt: idlePrompt(signal),
    options: { cwd, settingSources: ['user', 'project', 'local'], env: probeEnv(), plugins: loadedPlugins },
  })

/** A snapshot older than this is still served, while a new probe replaces it. */
const FRESH_MS = 60 * 60 * 1000
/** Redis keeps snapshots long past fresh, so a restart or a quiet directory still answers at once. */
const SHARED_TTL_S = 7 * 24 * 60 * 60
/** A directory whose probe failed gets no background probe again until this has passed. */
const RETRY_AFTER_MS = 60_000
const WARM_CONCURRENCY = 2

const sharedKey = (cwd: string) => `capabilities:${createHash('sha256').update(cwd).digest('hex').slice(0, 24)}`

const logFailure = (cwd: string) => (e: unknown) => {
  process.stderr.write(`capability probe of ${cwd} failed: ${e instanceof Error ? e.message : String(e)}\n`)
}

export interface CapabilityLookup {
  snapshot: CapabilitiesSnapshot
  /** The snapshot is of the directory asked about, not a stand-in from a nearby one. */
  exact: boolean
  /** Exact and younger than FRESH_MS; otherwise a probe for the directory is on its way. */
  fresh: boolean
}

/** Per-cwd snapshots with one in-flight probe each, shared with other processes through Redis. */
export function createCapabilityCache(start: StartProbe = startSdkProbe, timing: ProbeTiming = DEFAULT_TIMING) {
  const snapshots = new Map<string, CapabilitiesSnapshot>()
  const inflight = new Map<string, Promise<CapabilitiesSnapshot>>()
  const failedAt = new Map<string, number>()
  const followUps = new Map<string, Promise<CapabilitiesSnapshot>>()
  const isFresh = (snapshot: CapabilitiesSnapshot) => Date.now() - Date.parse(snapshot.probed_at) < FRESH_MS

  const joinOrProbe = async (cwd: string): Promise<CapabilitiesSnapshot> => {
    const running = inflight.get(cwd)
    if (running) {
      return running
    }
    const next = probePlugins()
      .then(async (plugins) => {
        loadedPlugins = plugins
        if (PROBE_DELAY_MS > 0) {
          await sleep(PROBE_DELAY_MS)
        }
        return probe(cwd, start, timing)
      })
      .then(async (snapshot) => {
        snapshots.set(cwd, snapshot)
        failedAt.delete(cwd)
        await cache.set(sharedKey(cwd), snapshot, SHARED_TTL_S)
        afterProbe()
        return snapshot
      })
      .catch((e: unknown) => {
        failedAt.set(cwd, Date.now())
        throw e
      })
      .finally(() => {
        inflight.delete(cwd)
      })
    inflight.set(cwd, next)
    return next
  }

  /** A probe that starts after this call, since a running one may predate a change to the config. */
  const refresh = async (cwd: string): Promise<CapabilitiesSnapshot> => {
    const running = inflight.get(cwd)
    if (running === undefined) {
      return joinOrProbe(cwd)
    }
    let next = followUps.get(cwd)
    if (next === undefined) {
      next = running
        .catch(() => undefined)
        .then(async () => {
          followUps.delete(cwd)
          return joinOrProbe(cwd)
        })
      followUps.set(cwd, next)
    }
    return next
  }

  const failedLately = (cwd: string) => Date.now() - (failedAt.get(cwd) ?? -Infinity) < RETRY_AFTER_MS

  /** Starts a probe nobody waits for, unless one is running or the last one just failed. */
  const revalidate = (cwd: string): void => {
    if (!inflight.has(cwd) && !failedLately(cwd)) {
      joinOrProbe(cwd).catch(logFailure(cwd))
    }
  }

  /** The last snapshot of a directory from this process or Redis, however old. */
  const stored = async (cwd: string): Promise<CapabilitiesSnapshot | undefined> => {
    const known = snapshots.get(cwd)
    if (known !== undefined) {
      return known
    }
    const shared = await cache.get<CapabilitiesSnapshot>(sharedKey(cwd))
    if (shared !== undefined) {
      snapshots.set(cwd, shared)
    }
    return shared
  }

  /** The first nearby directory with a snapshot, else the newest snapshot of any directory. */
  const standIn = async (nearby: readonly string[]): Promise<CapabilitiesSnapshot | undefined> => {
    for (const dir of nearby) {
      const snapshot = await stored(dir)
      if (snapshot !== undefined) {
        return snapshot
      }
    }
    return [...snapshots.values()].toSorted((a, b) => b.probed_at.localeCompare(a.probed_at))[0]
  }

  /** Takes a snapshot another process or an earlier run probed within `maxAgeMs`; false if none. */
  const warm = async (cwd: string, maxAgeMs: number, now = Date.now()): Promise<boolean> => {
    const shared = await cache.get<CapabilitiesSnapshot>(sharedKey(cwd))
    if (shared === undefined || now - Date.parse(shared.probed_at) >= maxAgeMs) {
      return false
    }
    snapshots.set(cwd, shared)
    return true
  }

  const queue: string[] = []
  let warming = false
  let active = 0

  const warmOne = async (cwd: string): Promise<void> => {
    const known = await stored(cwd)
    if ((known === undefined || !isFresh(known)) && !failedLately(cwd)) {
      await joinOrProbe(cwd).catch(logFailure(cwd))
    }
  }

  const pump = (): void => {
    while (active < WARM_CONCURRENCY) {
      const cwd = queue.shift()
      if (cwd === undefined) {
        return
      }
      active += 1
      void warmOne(cwd).finally(() => {
        active -= 1
        pump()
      })
    }
  }

  /** Queues a background probe of a directory once warming has started; no-op before. */
  const prewarm = (cwd: string): void => {
    if (warming && !queue.includes(cwd)) {
      queue.push(cwd)
      pump()
    }
  }

  return {
    cached: (cwd: string) => snapshots.get(cwd),
    /** Every snapshot this process holds, for names that span scopes. */
    all: () => [...snapshots.values()],
    /** The directory's snapshot; an old one is returned at once and probed again behind it. */
    get: async (cwd: string) => {
      const known = await stored(cwd)
      if (known === undefined) {
        return joinOrProbe(cwd)
      }
      if (!isFresh(known)) {
        revalidate(cwd)
      }
      return known
    },
    /** Answers without waiting for a probe when any snapshot, even a nearby directory's, exists. */
    lookup: async (cwd: string, nearby: readonly string[]): Promise<CapabilityLookup> => {
      const own = await stored(cwd)
      if (own !== undefined) {
        const fresh = isFresh(own)
        if (!fresh) {
          revalidate(cwd)
        }
        return { snapshot: own, exact: true, fresh }
      }
      const stand = await standIn(nearby)
      if (stand === undefined) {
        return { snapshot: await joinOrProbe(cwd), exact: true, fresh: true }
      }
      revalidate(cwd)
      return { snapshot: stand, exact: false, fresh: false }
    },
    refresh,
    warm,
    prewarm,
    /** Lets task directories be probed ahead of use, a few at a time, starting with these. */
    startWarming: (cwds: readonly string[]) => {
      warming = true
      for (const cwd of cwds) {
        prewarm(cwd)
      }
    },
  }
}

export const capabilityCache = createCapabilityCache()
