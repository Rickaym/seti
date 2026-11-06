import { randomUUID } from 'node:crypto'
import { MOD_LIMITS, type ModCaller, type ModCapabilityName, type ModEvent, type ModGrantScopes } from '@seti/shared'
import type { ModEventResult, ModLogicJob } from './child.js'
import { ModState } from './mod-state.js'

/** A mod as it runs now: its verified script by hash and its grants, all from Seti's records. */
export interface ModLogicTarget {
  modId: string
  name: string
  version: string
  hash: string
  script: string
  grants: readonly ModCapabilityName[]
  scopes: ModGrantScopes
}

/** Who fired an event; agentId is set when an agent or an agent-tab view called. */
export interface ModEventOrigin {
  caller: ModCaller
  agentId?: string
}

export interface ModEventsDeps {
  run: (job: ModLogicJob) => Promise<ModEventResult>
  /** Events that may run at once across every mod: the pool's size. */
  concurrency: number
  /** The mod as it runs now, or null when it is off, held by safe mode or has no logic. */
  target: (modId: string) => Promise<ModLogicTarget | null>
  /** Records a finished or dropped event: its compute, logs and error. */
  record: (target: ModLogicTarget, event: ModEvent, result: ModEventResult) => Promise<void>
  /** Compute the mod used today, in ms, as recorded. */
  usedToday: (modId: string) => Promise<number>
  /** Seti turns the mod off, as itself and audited; off is always Seti's to choose. */
  turnOff: (target: ModLogicTarget, reason: string) => Promise<void>
  /** The mod stopped running for a while; the user is told once. */
  paused: (target: ModLogicTarget, reason: string) => Promise<void>
  now?: () => number
}

interface Pending {
  target: ModLogicTarget
  event: ModEvent
  origin: ModEventOrigin
  resolve: (result: ModEventResult) => void
}

const NO_USAGE = { cpuMs: 0, calls: 0 }

const background = (event: ModEvent) => event.kind === 'schedule' || event.kind === 'task'

const notRun = (code: 'busy' | 'denied', message: string): ModEventResult => ({
  ok: false,
  error: { code, message },
  logs: [],
  usage: NO_USAGE,
  refused: [],
})

const busy = (message: string) => notRun('busy', message)

/** Queues each mod's events, runs one per mod at a time, and takes mods in turn so none starves. */
export function createModEvents(deps: ModEventsDeps) {
  const now = deps.now ?? Date.now
  const mods = new Map<string, ModState<Pending>>()
  const turn: string[] = []
  let running = 0

  /** Puts a mod with queued events at the back of the line, once. */
  const wait = (modId: string, state: ModState<Pending>) => {
    if (!state.running && state.queue.length > 0 && !turn.includes(modId) && mods.get(modId) === state) {
      turn.push(modId)
    }
  }

  const stateOf = (modId: string): ModState<Pending> => {
    const state = mods.get(modId) ?? new ModState<Pending>()
    mods.set(modId, state)
    return state
  }

  /** Makes room in a full queue by dropping its oldest background event; false when none. */
  function dropOldestBackground(state: ModState<Pending>): boolean {
    const index = state.queue.findIndex((pending) => background(pending.event))
    const [dropped] = index === -1 ? [] : state.queue.splice(index, 1)
    if (dropped === undefined) {
      return false
    }
    const result = busy(`${dropped.target.name}'s queue was full, so this ${dropped.event.kind} event was dropped`)
    void deps.record(dropped.target, dropped.event, result)
    dropped.resolve(result)
    return true
  }

  async function settle(target: ModLogicTarget, state: ModState<Pending>, result: ModEventResult): Promise<void> {
    const at = now()
    await state.today(at, async () => deps.usedToday(target.modId))
    const settled = state.settle(result, at)
    if (settled.paused) {
      const why = `${target.name} used its ${String(MOD_LIMITS.dailyCpuMs / 1000)} s of compute for today`
      await deps.paused(target, why)
    }
    if (settled.turnOff) {
      const times = String(MOD_LIMITS.failuresPerHourTurnsOff)
      await deps.turnOff(target, `${target.name} was turned off: it failed ${times} times in an hour`)
    }
  }

  async function execute(state: ModState<Pending>, pending: Pending): Promise<void> {
    const { event, origin } = pending
    const target = (await deps.target(pending.target.modId)) ?? null
    if (target === null) {
      pending.resolve(notRun('denied', `${pending.target.name} is off`))
      return
    }
    const eventId = randomUUID()
    const agent = origin.agentId === undefined ? {} : { agentId: origin.agentId }
    const result = await deps.run({
      run: { modId: target.modId, grants: target.grants, scopes: target.scopes, eventId, caller: origin.caller },
      version: target.version,
      hash: target.hash,
      script: target.script,
      event,
      wallMs: event.kind === 'schedule' ? MOD_LIMITS.scheduleWallMs : MOD_LIMITS.wallMs,
      ...agent,
    })
    await settle(target, state, result)
    await deps.record(target, event, result)
    pending.resolve(result)
  }

  /** Starts events while there is room, taking the mods that wait in the order they came. */
  function pump(): void {
    while (running < deps.concurrency) {
      const modId = turn.shift()
      const state = modId === undefined ? undefined : mods.get(modId)
      if (modId === undefined) {
        return
      }
      const pending = state?.queue.shift()
      if (state === undefined || pending === undefined || state.running) {
        continue
      }
      state.started(now())
      running += 1
      void execute(state, pending)
        .catch((e: unknown) => {
          pending.resolve(busy(e instanceof Error ? e.message : String(e)))
        })
        .finally(() => {
          state.finished()
          running -= 1
          wait(modId, state)
          pump()
        })
    }
  }

  return {
    /**
     * Fires one event for a mod. Resolves with its result; a code of busy means it did not run,
     * which a webhook answers with 503 so the sender retries.
     */
    fire: async (modId: string, event: ModEvent, origin: ModEventOrigin): Promise<ModEventResult> => {
      const target = await deps.target(modId)
      if (target === null) {
        return notRun('denied', `The mod ${modId} is off`)
      }
      const state = stateOf(modId)
      const at = now()
      await state.today(at, async () => deps.usedToday(modId))
      const refused = state.refusal(target.name, at)
      if (refused !== null) {
        const result = busy(refused)
        await deps.record(target, event, result)
        return result
      }
      if (state.queue.length >= MOD_LIMITS.queuePerMod && !(background(event) && dropOldestBackground(state))) {
        const result = busy(`${target.name} is busy; try again`)
        await deps.record(target, event, result)
        return result
      }
      const done = new Promise<ModEventResult>((resolve) => {
        state.queue.push({ target, event, origin, resolve })
      })
      wait(modId, state)
      pump()
      return done
    },
    /** Forgets a mod's queue and counters, as it is turned off or updated; queued events end busy. */
    forget: (modId: string): void => {
      const state = mods.get(modId)
      for (const pending of state?.queue.splice(0) ?? []) {
        pending.resolve(notRun('denied', `${pending.target.name} was turned off`))
      }
      mods.delete(modId)
      turn.splice(0, turn.length, ...turn.filter((entry) => entry !== modId))
    },
  }
}
