import type { InputSubtask, PrInput, PrInputKind } from '@seti/shared'
import { PR_POLL_MS } from './config.js'
import { watchPrInputs } from './ea-watch.js'
import { canPollGithub } from './github-cache.js'
import { fetchWatchedPrs, viewerLogin, type WatchedPr } from './github.js'
import { deliverInputs } from './inputs.js'
import { unlinkEndedPrs } from './pr-ended.js'
import { freshPosts, prEvents, type PrPost, type PrSnapshot } from './pr-events.js'
import { agentPosts } from './pr-self.js'
import { openQuerySince } from './runner.js'
import { prHeld, type HeldGroup, type HeldInput } from './store/pr-held.js'
import { prWatch, type PrListener } from './store/pr-watch.js'
import { inputSubtask } from './subtask-prs.js'

/** Updates held for a running subagent go out after this long even if it never ends. */
const PR_HOLD_MAX_MS = 30 * 60_000

/** Where the updates of a running subagent's PRs wait, so they outlast a restart. */
interface HeldStore {
  hold: (taskId: string, toolUseId: string, inputs: readonly PrInput[], at: string) => Promise<void>
  groups: () => Promise<HeldGroup[]>
  of: (taskId: string, toolUseId: string) => Promise<HeldInput[]>
  drop: (ids: readonly number[]) => Promise<void>
}

const ENDS: readonly PrInputKind[] = ['merged', 'closed']

/** Updates of one PR replace each other within a slot: a CI result replaces the one before it. */
function slotOf(input: PrInput): string {
  if (input.kind === 'ci_passed' || input.kind === 'ci_failed') {
    return `${input.subject}\nci`
  }
  return `${input.subject}\n${ENDS.includes(input.kind) ? 'end' : input.kind}`
}

/** The newest held update of each PR and slot, in order; once a PR ended, only its end is left. */
function foldHeld(inputs: readonly PrInput[]): PrInput[] {
  const ended = new Set(inputs.filter((input) => ENDS.includes(input.kind)).map((input) => input.subject))
  const newest = new Map(inputs.map((input, index) => [slotOf(input), index]))
  return inputs.filter(
    (input, index) => newest.get(slotOf(input)) === index && (!ended.has(input.subject) || ENDS.includes(input.kind)),
  )
}

const addressed = (inputs: readonly PrInput[], subtask: InputSubtask | null): PrInput[] =>
  subtask === null ? [...inputs] : inputs.map((input) => ({ ...input, subtask }))

export interface PrInputDeps {
  watched: () => Promise<string[]>
  listeners: (url: string) => Promise<PrListener[]>
  /** The subagent a PR linked to it concerns, or null when the task no longer has it. */
  subtask: (taskId: string, toolUseId: string) => Promise<InputSubtask | null>
  snapshot: (url: string) => Promise<PrSnapshot | undefined>
  save: (url: string, snapshot: PrSnapshot) => Promise<void>
  fetch: (urls: readonly string[]) => Promise<Map<string, WatchedPr | null>>
  viewer: () => Promise<string>
  /** Ids of the new reviews and comments on the PR that its agents posted themselves. */
  agentPosts?: (url: string, posts: readonly PrPost[], viewer: string) => Promise<ReadonlySet<string>>
  deliver: (taskId: string, inputs: readonly PrInput[]) => Promise<unknown>
  /** Drops the links to PRs that merged or closed, once their last update went out. */
  unlinkEnded?: () => Promise<unknown>
  /** Tasks the EA watches that link the PR, and where their changes go; the tasks never see them. */
  eaWatchers?: (url: string) => Promise<string[]>
  notifyEa?: (taskId: string, inputs: readonly PrInput[]) => Promise<void>
  onError: (error: unknown) => void
  /** False while the GitHub budget is too low to spend on polling; the poll waits a turn. */
  canPoll?: () => Promise<boolean>
  /** Holds updates while the subagent that owns the PR runs; without it they go out at once. */
  held?: HeldStore
  now?: () => number
}

/** Polls the PRs linked to tasks and hands each task the changes as updates. */
export function createPrInputPoller(deps: PrInputDeps) {
  let polling = false
  let timer: NodeJS.Timeout | null = null

  const add = (into: Map<string, PrInput[]>, taskIds: readonly string[], inputs: readonly PrInput[]) => {
    for (const taskId of taskIds) {
      into.set(taskId, [...(into.get(taskId) ?? []), ...inputs])
    }
  }

  const now = deps.now ?? Date.now

  /**
   * Updates of a PR linked to a subagent name it, so its parent agent can pass them on. While the
   * subagent runs it watches the PR itself, so they wait for it to end; null when they wait.
   */
  async function routed(listener: PrListener, inputs: readonly PrInput[]): Promise<PrInput[] | null> {
    const call = listener.tool_use_id
    const subtask = call === null ? null : await deps.subtask(listener.task_id, call)
    if (call !== null && subtask?.running === true && deps.held !== undefined) {
      await deps.held.hold(listener.task_id, call, inputs, new Date(now()).toISOString())
      return null
    }
    return addressed(inputs, subtask)
  }

  /** Hands over what was held for subagents that ended, or that held it past PR_HOLD_MAX_MS. */
  async function release(held: HeldStore): Promise<void> {
    for (const group of await held.groups()) {
      const subtask = await deps.subtask(group.task_id, group.tool_use_id)
      if (subtask?.running === true && now() - Date.parse(group.since) < PR_HOLD_MAX_MS) {
        continue
      }
      const rows = await held.of(group.task_id, group.tool_use_id)
      if (rows.length === 0) {
        continue
      }
      try {
        await deps.deliver(group.task_id, addressed(foldHeld(rows.map((row) => row.input)), subtask))
        await held.drop(rows.map((row) => row.id))
      } catch (e) {
        deps.onError(e)
      }
    }
  }

  async function collect(urls: readonly string[], found: Map<string, WatchedPr | null>, viewer: string) {
    const perTask = new Map<string, PrInput[]>()
    const perWatch = new Map<string, PrInput[]>()
    for (const url of urls) {
      const pr = found.get(url)
      if (!pr) {
        continue
      }
      const previous = await deps.snapshot(url)
      const posts = freshPosts(previous, pr)
      const own = posts.length === 0 ? undefined : await deps.agentPosts?.(url, posts, viewer)
      const { inputs, next } = prEvents(previous, pr, own, now())
      await deps.save(url, next)
      if (inputs.length > 0) {
        for (const listener of await deps.listeners(url)) {
          const routedInputs = await routed(listener, inputs)
          if (routedInputs !== null) {
            add(perTask, [listener.task_id], routedInputs)
          }
        }
        add(perWatch, (await deps.eaWatchers?.(url)) ?? [], inputs)
      }
    }
    return { perTask, perWatch }
  }

  async function poll(): Promise<void> {
    if (polling) {
      return
    }
    polling = true
    try {
      if (deps.held !== undefined) {
        await release(deps.held)
      }
      const urls = await deps.watched()
      if (urls.length === 0) {
        return
      }
      if (deps.canPoll !== undefined && !(await deps.canPoll())) {
        deps.onError(new Error('the GitHub GraphQL budget is low; polling waits for it to refill'))
        return
      }
      const [viewer, found] = await Promise.all([deps.viewer(), deps.fetch(urls)])
      const { perTask, perWatch } = await collect(urls, found, viewer)
      for (const [taskId, inputs] of perWatch) {
        await deps.notifyEa?.(taskId, inputs)
      }
      for (const [taskId, inputs] of perTask) {
        try {
          await deps.deliver(taskId, inputs)
        } catch (e) {
          deps.onError(e)
        }
      }
      await deps.unlinkEnded?.()
    } catch (e) {
      deps.onError(e)
    } finally {
      polling = false
    }
  }

  return {
    poll,
    /** Polls on an interval, and first drops links to PRs that ended while Seti was down. */
    start: (intervalMs = PR_POLL_MS) => {
      if (timer === null) {
        deps.unlinkEnded?.().catch(deps.onError)
        timer = setInterval(() => void poll(), intervalMs)
      }
    },
    stop: () => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}

let lastError = ''

export const prInputs = createPrInputPoller({
  watched: prWatch.watched,
  listeners: prWatch.listeners,
  subtask: async (taskId, toolUseId) => inputSubtask(taskId, toolUseId, openQuerySince(taskId)),
  snapshot: prWatch.snapshot,
  save: prWatch.save,
  fetch: fetchWatchedPrs,
  viewer: viewerLogin,
  agentPosts,
  deliver: deliverInputs,
  unlinkEnded: unlinkEndedPrs,
  eaWatchers: prWatch.eaWatchers,
  notifyEa: watchPrInputs,
  canPoll: async () => canPollGithub(),
  held: prHeld,
  onError: (error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message !== lastError) {
      lastError = message
      process.stderr.write(`pr updates: ${message}\n`)
    }
  },
})
