import type { InputSubtask, PrInput, PrInputKind } from '@seti/shared'
import { PR_POLL_MS } from './config.js'
import { watchPrInputs } from './ea-watch.js'
import { canPollGithub } from './github-cache.js'
import { fetchWatchedPrs, viewerLogin, type WatchedPr } from './github.js'
import { deliverInputs } from './inputs.js'
import { unlinkEndedPrs } from './pr-ended.js'
import { freshPosts, prEvents, type PrPost, type PrReader, type PrSnapshot } from './pr-events.js'
import { agentEnders, agentPosts, awaitsCi } from './pr-self.js'
import { prChanged } from './prs.js'
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

/** What the agents did on a PR themselves since the last poll, which decides who hears what. */
interface OwnActions {
  posts: ReadonlyMap<string, string>
  enders: ReadonlySet<string>
  /** A pass came that only wakes a task waiting for it. */
  passed: boolean
}

export interface PrInputDeps {
  watched: () => Promise<string[]>
  listeners: (url: string) => Promise<PrListener[]>
  /** The subagent a PR linked to it concerns, or null when the task no longer has it. */
  subtask: (taskId: string, toolUseId: string) => Promise<InputSubtask | null>
  snapshot: (url: string) => Promise<PrSnapshot | undefined>
  save: (url: string, snapshot: PrSnapshot) => Promise<void>
  fetch: (urls: readonly string[]) => Promise<Map<string, WatchedPr | null>>
  viewer: () => Promise<string>
  /** The new reviews and comments on the PR that its agents posted, by id with the posting task. */
  agentPosts?: (url: string, posts: readonly PrPost[], viewer: string) => Promise<ReadonlyMap<string, string>>
  /** The tasks that merged or closed the PR themselves. */
  agentEnders?: (pr: WatchedPr) => Promise<ReadonlySet<string>>
  /** Whether the task pushed something whose CI result it has not been given yet. */
  awaitsCi?: (taskId: string, pr: WatchedPr) => Promise<boolean>
  deliver: (taskId: string, inputs: readonly PrInput[]) => Promise<unknown>
  /** Drops the links to PRs that merged or closed, once their last update went out. */
  unlinkEnded?: () => Promise<unknown>
  /** Tasks the EA watches that link the PR, and where their changes go; the tasks never see them. */
  eaWatchers?: (url: string) => Promise<string[]>
  notifyEa?: (taskId: string, inputs: readonly PrInput[]) => Promise<void>
  onError: (error: unknown) => void
  /** Hears each PR whose state, CI, reviews or comments changed since the last poll. */
  changed?: (url: string) => Promise<void>
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
    for (const taskId of inputs.length === 0 ? [] : taskIds) {
      into.set(taskId, [...(into.get(taskId) ?? []), ...inputs])
    }
  }

  const now = deps.now ?? Date.now

  /**
   * Updates of a PR linked to a subagent name it, so its parent agent can pass them on. While the
   * subagent runs it watches the PR itself, so they wait for it to end; quiet ones are recorded
   * at once. Returns what goes out now.
   */
  async function routed(listener: PrListener, inputs: readonly PrInput[]): Promise<PrInput[]> {
    const call = listener.tool_use_id
    const subtask = call === null ? null : await deps.subtask(listener.task_id, call)
    if (call !== null && subtask?.running === true && deps.held !== undefined) {
      const waiting = inputs.filter((input) => input.quiet === undefined)
      await deps.held.hold(listener.task_id, call, waiting, new Date(now()).toISOString())
      return addressed(
        inputs.filter((input) => input.quiet !== undefined),
        subtask,
      )
    }
    return addressed(inputs, subtask)
  }

  /** Who posted the new reviews and comments, who ended the PR, and whether a pass needs a waiter. */
  async function ownActions(previous: PrSnapshot | undefined, pr: WatchedPr, viewer: string): Promise<OwnActions> {
    const posts = freshPosts(previous, pr)
    const authors = posts.length === 0 ? undefined : await deps.agentPosts?.(pr.url, posts, viewer)
    const unread = prEvents(previous, pr, { awaitsCi: false }, now()).inputs
    const ended = unread.some((input) => ENDS.includes(input.kind))
    return {
      posts: authors ?? new Map<string, string>(),
      enders: (ended ? await deps.agentEnders?.(pr) : undefined) ?? new Set<string>(),
      passed: unread.some((input) => input.quiet === 'nothing_pending'),
    }
  }

  /** What one task did on the PR itself. */
  async function readerOf(taskId: string, pr: WatchedPr, own: OwnActions): Promise<PrReader> {
    const posts = new Set([...own.posts].filter(([, author]) => author === taskId).map(([id]) => id))
    const waits = own.passed ? await deps.awaitsCi?.(taskId, pr) : undefined
    return { posts, ended: own.enders.has(taskId), ...(waits === undefined ? {} : { awaitsCi: waits }) }
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
      const own = await ownActions(previous, pr, viewer)
      const { inputs, next } = prEvents(previous, pr, { posts: new Set(own.posts.keys()) }, now())
      await deps.save(url, next)
      if (inputs.length > 0) {
        await deps.changed?.(url)
        for (const listener of await deps.listeners(url)) {
          const reader = await readerOf(listener.task_id, pr, own)
          add(perTask, [listener.task_id], await routed(listener, prEvents(previous, pr, reader, now()).inputs))
        }
        const news = inputs.filter((input) => input.quiet === undefined)
        add(perWatch, (await deps.eaWatchers?.(url)) ?? [], news)
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
  agentEnders,
  awaitsCi,
  deliver: deliverInputs,
  unlinkEnded: unlinkEndedPrs,
  eaWatchers: prWatch.eaWatchers,
  notifyEa: watchPrInputs,
  changed: prChanged,
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
