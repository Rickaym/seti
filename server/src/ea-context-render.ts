import {
  unresolvedThreadsText,
  type EaContext,
  type EaContextTask,
  type MessageRow,
  type TeamMessage,
} from '@seti/shared'
import {
  CI_WORDS,
  clip,
  HOUR,
  quote,
  repoName,
  since,
  span,
  taskSection,
  taskViews,
  type ContextInput,
  type Line,
  type OpenPrView,
  type Section,
  type TaskView,
} from './ea-context-tasks.js'
import { redactCredentials } from './scrub.js'

/** About 1,500 tokens at four characters per token. */
export const CONTEXT_BUDGET_CHARS = 6000
const LINE_CHARS = 300
const EVENT_LINES = 8
const LISTED_PRS_MAX = 12
const SHOWN_CHECKS = 4
const TASKS_RETURNED = 300
const EVENT_WINDOW_MS = HOUR
const TEAM_WINDOW_MS = 6 * HOUR
const TEAM_LINES = 8
const TEAM_CHARS = 160
/** Events and chat messages always shown, however many tasks and PRs compete for the budget. */
const NEWEST_KEPT = 3
const ADDRESSED_MESSAGE = 72

const sectionText = (section: Section, shown: readonly Line[], hidden: readonly Line[]) =>
  [section.heading, ...shown.map((line) => line.text), section.rest(hidden)].filter((line) => line !== null).join('\n')

interface Target {
  section: number
  line: number
  priority: number
}

/** The least important line a section does not keep; among equals, the one listed last. */
function leastImportant(sections: readonly Section[], kept: readonly (readonly Line[])[]): Target | null {
  let target: Target | null = null
  kept.forEach((lines, section) => {
    const keep = sections[section]?.keep ?? 0
    lines.forEach((line, index) => {
      if (index >= keep && (target === null || line.priority <= target.priority)) {
        target = { section, line: index, priority: line.priority }
      }
    })
  })
  return target
}

/** Drops the least important lines until the sections fit in `budget` characters. */
function fitSections(header: string, sections: readonly Section[], budget: number): string {
  const kept = sections.map((section) => [...section.lines])
  const hidden = sections.map((): Line[] => [])
  const render = () =>
    [header, ...sections.map((section, i) => sectionText(section, kept[i] ?? [], hidden[i] ?? []))].join('\n\n')
  let text = render()
  for (
    let target = leastImportant(sections, kept);
    text.length > budget && target !== null;
    target = leastImportant(sections, kept)
  ) {
    const [removed] = kept[target.section]?.splice(target.line, 1) ?? []
    if (removed !== undefined) {
      hidden[target.section]?.push(removed)
    }
    text = render()
  }
  return text
}

const PR_RULES: readonly [(pr: OpenPrView) => boolean, number][] = [
  [(pr) => pr.ci === 'failure', 80],
  [(pr) => pr.mergeable === 'conflicting', 75],
  [(pr) => pr.review_decision === 'changes_requested', 70],
  [(pr) => pr.unresolved_threads > 0, 60],
  [(pr) => pr.ci === 'pending', 50],
]

const prPriority = (pr: OpenPrView, running: boolean) =>
  (PR_RULES.find(([applies]) => applies(pr))?.[1] ?? 42) + (running ? 5 : 0)

const REVIEW_WORDS: Record<NonNullable<OpenPrView['review_decision']>, string> = {
  approved: 'approved',
  changes_requested: 'changes requested',
  review_required: 'review required',
}

function ciWords(pr: OpenPrView): string {
  if (pr.ci === null) {
    return 'no CI'
  }
  const failing = pr.checks.filter((check) => check.state === 'failure').map((check) => check.name)
  if (pr.ci !== 'failure' || failing.length === 0) {
    return CI_WORDS[pr.ci]
  }
  const rest = failing.length > SHOWN_CHECKS ? ` and ${String(failing.length - SHOWN_CHECKS)} more` : ''
  return `CI failing: ${failing.slice(0, SHOWN_CHECKS).join(', ')}${rest}`
}

function previewWords(preview: OpenPrView['preview']): string | null {
  if (preview.state === 'none') {
    return null
  }
  return preview.state === 'ready' && preview.stale ? 'preview stale' : `preview ${preview.state}`
}

function prLine(pr: OpenPrView, owners: readonly string[], mine: boolean): string {
  const whose = [mine ? 'yours' : null, ...owners.map((title) => `task ${quote(title)}`)].filter(
    (part) => part !== null,
  )
  const parts = [
    ciWords(pr),
    unresolvedThreadsText(pr.unresolved_threads),
    pr.review_decision === null ? null : REVIEW_WORDS[pr.review_decision],
    pr.mergeable === 'conflicting' ? 'merge conflicts' : null,
    previewWords(pr.preview),
    pr.draft ? 'draft' : null,
  ].filter((part) => part !== null)
  const label = `${repoName(pr.repo_slug)}#${String(pr.number)} ${quote(pr.title)}`
  const line = `${label} (${whose.join(', ')}): ${parts.join('; ')}`
  return `- ${clip(line, LINE_CHARS)}`
}

const noLines = (heading: string): Section => ({ heading, lines: [], rest: () => null })

function prSection(input: ContextInput, views: readonly TaskView[]): Section {
  if (input.prs === null) {
    return noLines('Open PRs: GitHub has not answered yet; use a tool for PR state.')
  }
  const owners = new Map<string, TaskView[]>()
  for (const view of views) {
    for (const url of view.task.pr_urls) {
      owners.set(url, [...(owners.get(url) ?? []), view])
    }
  }
  const viewer = input.viewer?.toLowerCase() ?? null
  const isMine = (pr: OpenPrView) => viewer !== null && pr.author?.toLowerCase() === viewer
  const shown = input.prs.filter((pr) => isMine(pr) || owners.has(pr.url))
  if (shown.length === 0) {
    return noLines('Open PRs: none of yours and none linked to tasks.')
  }
  const mine = shown.filter(isMine).length
  const lines = shown
    .map((pr) => {
      const linked = owners.get(pr.url) ?? []
      const running = linked.some((view) => view.status === 'running')
      const text = prLine(
        pr,
        linked.map((view) => view.task.title),
        isMine(pr),
      )
      return { text, priority: prPriority(pr, running), key: pr.ci ?? 'none' }
    })
    .toSorted((a, b) => b.priority - a.priority)
  const unlisted = lines.slice(LISTED_PRS_MAX)
  const others = String(shown.length - mine)
  return {
    heading: `Open PRs: ${String(shown.length)} (${String(mine)} yours, ${others} others linked to tasks). Needing attention first:`,
    lines: lines.slice(0, LISTED_PRS_MAX),
    rest: (hidden) => {
      const left = [...hidden, ...unlisted]
      if (left.length === 0) {
        return null
      }
      const green = left.filter((line) => line.key === 'success').length
      return `Not listed: ${String(left.length)} more open PRs, ${String(green)} of them with CI green.`
    },
  }
}

const SERIOUS = 38
const ROUTINE = 30

/** A note from Seti; a session restart, or a tool the memory cap stopped, is routine. */
function setiText(payload: Extract<MessageRow, { kind: 'seti' }>['payload'], task: string) {
  const routine =
    payload.session !== undefined ||
    payload.seti_control !== undefined ||
    payload.bypass !== undefined ||
    (payload.memory !== undefined && payload.ended_turn !== true)
  return routine
    ? { text: `${payload.error} (${task})`, priority: ROUTINE }
    : { text: `${task} hit an error: ${clip(payload.error, 100)}`, priority: SERIOUS }
}

function eventText(
  row: MessageRow,
  title: string,
  eaChannels: ReadonlySet<string>,
): { text: string; priority: number } | null {
  const task = `task ${quote(title)}`
  if (row.kind === 'input') {
    if (row.payload.source === 'channel' && !eaChannels.has(row.payload.channel_id)) {
      return null
    }
    const serious = row.payload.kind === 'ci_failed' || row.payload.kind === 'conflict'
    const dismissed = row.payload.dismissed_at === undefined ? '' : ', dismissed'
    return { text: `${row.payload.title} (${task}${dismissed})`, priority: serious ? SERIOUS : ROUTINE }
  }
  if (row.kind === 'seti') {
    return setiText(row.payload, task)
  }
  if (row.kind !== 'sdk' || row.payload.type !== 'result') {
    return null
  }
  const failed = row.payload.subtype !== 'success' || row.payload.is_error
  return failed
    ? { text: `${task} ended its turn with an error`, priority: SERIOUS }
    : { text: `${task} finished its turn`, priority: ROUTINE }
}

function eventSection(input: ContextInput): Section | null {
  const titles = new Map(input.tasks.map((task) => [task.id, task.title]))
  const recent = (at: string) => since(input.now, at) <= EVENT_WINDOW_MS
  const fromTasks = input.notable
    .filter((row) => recent(row.created_at))
    .flatMap((row) => {
      const event = eventText(row, titles.get(row.task_id) ?? 'deleted task', input.eaChannels)
      return event === null ? [] : [{ ...event, at: row.created_at }]
    })
  const events = fromTasks.toSorted((a, b) => b.at.localeCompare(a.at)).slice(0, EVENT_LINES)
  if (events.length === 0) {
    return null
  }
  return {
    heading: 'In the last hour, newest first:',
    lines: events.map((event) => ({
      text: `- ${span(since(input.now, event.at))} ago: ${clip(event.text, LINE_CHARS)}`,
      priority: event.priority,
    })),
    keep: NEWEST_KEPT,
    rest: (hidden) => (hidden.length === 0 ? null : `And ${String(hidden.length)} more events.`),
  }
}

const teamAuthor = (message: TeamMessage) => {
  if (message.author_kind === 'mod') {
    return `mod:${message.author_mod_id ?? 'unknown'}`
  }
  return message.author_kind === 'task' ? `@${message.author_handle ?? 'agent'}` : message.author_kind
}

const teamPriority = (message: TeamMessage) =>
  message.mentions.some((mention) => mention.handle === 'user' || mention.handle === 'ea') ? ADDRESSED_MESSAGE : ROUTINE

function teamSection(input: ContextInput): Section | null {
  const recent = input.team
    .filter((message) => since(input.now, message.created_at) <= TEAM_WINDOW_MS)
    .toReversed()
    .slice(0, TEAM_LINES)
  if (recent.length === 0) {
    return null
  }
  const agents = new Set(recent.flatMap((message) => (message.author_task_id === null ? [] : [message.author_task_id])))
  return {
    heading: `Group chat in the last 6 hours, newest first (${String(recent.length)} messages, ${String(agents.size)} agents):`,
    lines: recent.map((message) => ({
      text: `- ${span(since(input.now, message.created_at))} ago ${teamAuthor(message)}: ${clip(message.text, TEAM_CHARS)}`,
      priority: teamPriority(message),
    })),
    keep: NEWEST_KEPT,
    rest: (hidden) =>
      hidden.length === 0 ? null : `And ${String(hidden.length)} more messages; read_team_chat has them.`,
  }
}

/** The live context text and the tasks it covers; never longer than `budget` characters. */
export function renderContext(input: ContextInput, budget = CONTEXT_BUDGET_CHARS): Omit<EaContext, 'as_of'> {
  const views = taskViews(input)
  const open = new Map((input.prs ?? []).map((pr) => [pr.url, pr]))
  const stamp = new Date(input.now).toISOString().replace('T', ' ').slice(0, 19)
  const header = `Seti live context as of ${stamp} UTC; times are relative to then.`
  const sections = [taskSection(views, input, open), prSection(input, views), eventSection(input), teamSection(input)]
  const fitted = fitSections(
    header,
    sections.filter((section) => section !== null),
    budget,
  )
  const text = redactCredentials(fitted).slice(0, budget)
  const covered: EaContextTask[] = views
    .slice(0, TASKS_RETURNED)
    .map((view) => ({ id: view.task.id, title: view.task.title, status: view.status }))
  return { text, tokens: Math.ceil(text.length / 4), tasks: covered }
}
