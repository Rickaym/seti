import fs from 'node:fs'
import path from 'node:path'
import type { DreamProposalInput, DreamReport, DreamRun, RuntimeEvent, Task } from '@seti/shared'
import { audit } from '../audit.js'
import { launchPlan } from '../launch-plan.js'
import { maintenanceLauncher } from '../launcher.js'
import type { DreamSession, DreamSupport, SessionMessage } from '../runtimes/adapter.js'
import { projectSlug } from '../sandbox-mounts.js'
import { isRunning } from '../session-mirror.js'
import { sandboxContext, workingDirs } from '../session-options.js'
import { dreamRuns, type DreamEnd } from '../store/dreams.js'
import { workspaceDir } from '../workspace/dir.js'
import { composeDigest, dayRows } from './digest.js'
import { dreamGate, type DreamPlaces } from './gate.js'
import { forgetBefore, keepBefore, recordAfter } from './kept.js'
import type { MemorySnapshot } from './memory-snapshot.js'
import { dreamAppend, dreamMessage } from './prompt.js'
import { fileProposal } from './proposals.js'
import { reportMarkdown } from './report.js'
import { dreamTools } from './tools.js'

/** What one dream may use: its model, `dream_steps`, `dream_time` and `dream_budget`. */
export interface DreamLimits {
  model: string
  steps: number
  timeMs: number
  budgetUsd: number
  /** When a nightly dream's window ends, as epoch milliseconds; it stops there. */
  until?: number
  /** Whether it may propose clean-ups for the user to allow. */
  cleanups?: boolean
}

export const DREAM_LIMITS: DreamLimits = { model: 'claude-sonnet-5-5', steps: 60, timeMs: 20 * 60_000, budgetUsd: 1 }

/** How to stop each dream that runs now, by run id. */
const stoppers = new Map<number, (reason: string) => void>()

/** Stops a running dream, keeping what it recorded; false when it is not running here. */
export function stopDream(runId: number, reason: string): boolean {
  const stop = stoppers.get(runId)
  stop?.(reason)
  return stop !== undefined
}

/** How often a dream checks that its agent has not started a turn, which cuts the dream. */
const WATCH_MS = 5000

export interface DreamJob {
  task: Task
  run: DreamRun
  /** The agent's memory folder as the host sees it. */
  memory: string
  before: MemorySnapshot
  dream: DreamSupport
  limits: DreamLimits
}

/** What a dream did while it ran, counted from its reports and its gate. */
class Tally {
  steps = 0
  denials = 0
  cost = 0
  finished = false
  report: DreamReport | null = null
  end: { state: DreamEnd['state']; reason: string | null } | null = null

  /** Keeps the first way the dream ended; a later one does not replace it. */
  ended(state: DreamEnd['state'], reason: string | null): void {
    this.end ??= { state, reason }
  }

  denied(refusal: string | null): void {
    this.denials += refusal === null ? 0 : 1
  }

  reported(report: DreamReport): void {
    this.report = report
  }

  /** Takes one message: its events, and the dream's cost so far where the runtime reports it. */
  take(message: SessionMessage, reportedCost: DreamSupport['reportedCost']): void {
    message.events.forEach((event) => {
      this.count(event)
    })
    this.cost = reportedCost(message.raw) ?? this.cost
  }

  /** Whether the dream spent past its budget while its runtime let it go on. */
  overBudget(budgetUsd: number): boolean {
    return this.end === null && !this.finished && this.cost > budgetUsd
  }

  private count(event: RuntimeEvent): void {
    if (event.type === 'tool.started' && event.thread === '') {
      this.steps += 1
    } else if (event.type === 'turn.ended') {
      this.finished = true
      this.cost = event.costUsd ?? this.cost
      if (event.ending === 'budget_limit') {
        this.ended('stopped', 'It reached its budget.')
      } else if (event.ending === 'turn_limit') {
        this.ended('stopped', 'It reached its step limit.')
      } else if (event.status === 'error') {
        this.ended('failed', event.error ?? event.result)
      }
    }
  }
}

/** The night's folder in the agent's workspace, which the dream may write: digest and report. */
const nightDir = (job: DreamJob) => path.join(workspaceDir(job.task.id), 'dreams', job.run.night)

/** When the agent last dreamt to the end, which the digest starts from. */
async function lastDream(job: DreamJob): Promise<string | null> {
  const done = (await dreamRuns.forTask(job.task.id, 20)).find((run) => run.id !== job.run.id && run.state === 'done')
  return done?.ended_at ?? null
}

async function writeDigest(job: DreamJob, since: string | null): Promise<string> {
  const { rows, truncated } = await dayRows(job.task.id, since)
  const text = composeDigest({
    title: job.task.title,
    night: job.run.night,
    since,
    rows,
    prUrls: job.task.pr_urls,
    truncated,
  })
  const file = path.join(nightDir(job), 'digest.md')
  fs.writeFileSync(file, text, { mode: 0o600 })
  return file
}

/** Follows the session to its end, stopping it at the time limit or when the agent starts a turn. */
async function follow(session: DreamSession, job: DreamJob, tally: Tally): Promise<void> {
  const stop = (state: DreamEnd['state'], reason: string) => {
    tally.ended(state, reason)
    void session.interrupt().finally(() => {
      session.close()
    })
  }
  const { timeMs, until } = job.limits
  const atEnd = until !== undefined && until - Date.now() < timeMs
  const timer = setTimeout(
    () => {
      stop('stopped', atEnd ? 'The window ended.' : 'It reached its time limit.')
    },
    atEnd ? Math.max(0, until - Date.now()) : timeMs,
  )
  stoppers.set(job.run.id, (reason) => {
    stop('stopped', reason)
  })
  const watch = setInterval(() => {
    if (isRunning(job.task.id)) {
      stop('cut', 'The agent started a turn.')
    }
  }, WATCH_MS)
  try {
    for await (const report of session.events) {
      if (report.type === 'message') {
        tally.take(report, job.dream.reportedCost)
      }
      if (tally.overBudget(job.limits.budgetUsd)) {
        stop('stopped', 'It reached its budget.')
      }
    }
  } finally {
    stoppers.delete(job.run.id)
    clearTimeout(timer)
    clearInterval(watch)
    session.close()
  }
}

/** Where the dream's folders are as its sandbox shows them, for the gate. */
function placesOf(job: DreamJob, night: string): DreamPlaces {
  const home = sandboxContext().home
  const memory = path.join(home, '.claude', 'projects', projectSlug(job.task.cwd), 'memory')
  const work = [job.task.cwd, ...workingDirs(job.task)]
  return { cwd: job.task.cwd, home, readable: [...work, memory], memory, night }
}

async function dreamSession(job: DreamJob, tally: Tally, night: string): Promise<void> {
  const launcher = await maintenanceLauncher(job.task, { writable: [night] }, await launchPlan(job.task))
  if (launcher === null) {
    throw new Error('The agent runs without the sandbox, so a dream could not be contained.')
  }
  const since = await lastDream(job)
  const digest = await writeDigest(job, since)
  const places = placesOf(job, night)
  const gate = (call: Parameters<typeof dreamGate>[0]) => {
    const refusal = dreamGate(call, places, job.memory)
    tally.denied(refusal)
    return refusal
  }
  const propose =
    job.limits.cleanups === true ? async (input: DreamProposalInput) => fileProposal(job.task, job.run, input) : null
  const tools = dreamTools(async (report) => {
    tally.reported(report)
    return Promise.resolve()
  }, propose)
  const spec = {
    taskId: job.task.id,
    cwd: job.task.cwd,
    dirs: workingDirs(job.task),
    model: job.limits.model,
    append: await dreamAppend(job.task.id, job.task.title, places.memory),
    prompt: dreamMessage({
      night: job.run.night,
      lastDream: since,
      digest,
      memory: places.memory,
      shared: [],
      maxSteps: job.limits.steps,
      budgetUsd: job.limits.budgetUsd,
      cleanups: job.limits.cleanups === true,
    }),
    maxTurns: job.limits.steps,
    budgetUsd: job.limits.budgetUsd,
  }
  const session = await job.dream.open(spec, launcher, { gate, tools }, new AbortController())
  await follow(session, job, tally)
}

/**
 * Runs one dream to its end: writes the day's digest, runs the session in the agent's maintenance
 * sandbox, records each memory file it changed as a revision, and stores and audits the outcome.
 */
export async function runDream(job: DreamJob): Promise<DreamRun | undefined> {
  const tally = new Tally()
  const night = nightDir(job)
  fs.mkdirSync(night, { recursive: true, mode: 0o700 })
  keepBefore(job.task.id, job.run.id, job.before)
  try {
    await dreamSession(job, tally, night)
  } catch (e) {
    tally.ended('failed', e instanceof Error ? e.message : String(e))
  }
  const after = await recordAfter(job.task.id, job.run, job.memory, job.before)
  forgetBefore(job.task.id, job.run.id)
  const found = [...(tally.report?.found ?? []), ...after.found].slice(0, 10)
  const report = tally.report === null ? null : { ...tally.report, found }
  const end: DreamEnd = {
    state: tally.end?.state ?? 'done',
    reason: tally.end?.reason ?? (report === null ? 'It ended without a report.' : null),
    cost_usd: tally.cost,
    steps: tally.steps,
    denials: tally.denials,
    memory_changes: after.changes,
    report,
  }
  fs.writeFileSync(path.join(night, 'report.md'), reportMarkdown(job.task.title, job.run.night, end), { mode: 0o600 })
  const ended = await dreamRuns.end(job.run.id, end)
  await audit.record({
    actor: 'system',
    kind: 'dream.ended',
    subject_type: 'task',
    subject_id: job.task.id,
    summary: `A dream of ${job.task.title} ended: ${end.state}, ${String(end.memory_changes)} memory files changed`,
    detail: {
      run: job.run.id,
      state: end.state,
      steps: end.steps,
      cost_usd: end.cost_usd,
      denials: end.denials,
      memory_changes: end.memory_changes,
    },
  })
  return ended
}
