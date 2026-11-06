import type { ModAgentPlace } from '@seti/mod-api'
import type { AgentColor, SubtaskStatus, TaskDisplayStatus, TodoStatus } from '@seti/shared'
import { Archive, Hand, MessageCircleQuestion } from 'lucide-react'
import { SUBTASK_LABEL } from '@/lib/subtasks'
import { cn } from '@/lib/utils'
import { ModStatusMarker } from './ModStatusMarker'
import { GLYPH_COLOUR, statusLabel, statusLightTitle, subagentsHint } from './status-label'

const STATUS_STYLE: Record<TaskDisplayStatus, string> = {
  running: 'bg-primary text-primary-foreground animate-pulse',
  idle: 'bg-success/20 text-foreground',
  complete: 'bg-success text-success-foreground',
  error: 'bg-destructive/20 text-destructive',
  stopped: 'bg-muted text-muted-foreground',
  interrupted: 'bg-warning/20 text-foreground',
  asking: 'bg-warning/20 text-foreground',
  blocked: 'bg-warning/40 text-foreground',
}

const PILL = 'shrink-0 px-1.5 py-0.5 text-2xs font-semibold uppercase'

/** A task's status; running subagents, which keep it running, show in the tooltip. */
const TITLES: Partial<Record<TaskDisplayStatus, string>> = {
  asking: 'Its turn ended with a question for you',
  blocked: 'It cannot go on until you answer it',
}

export function StatusPill({ status, subagents = 0 }: { status: TaskDisplayStatus; subagents?: number }) {
  const icon = status === 'asking' || status === 'blocked'
  return (
    <span
      className={cn(PILL, STATUS_STYLE[status], icon && 'inline-flex items-center gap-1')}
      title={TITLES[status] ?? subagentsHint(subagents)}
    >
      {status === 'asking' && <MessageCircleQuestion className="size-3" aria-hidden />}
      {status === 'blocked' && <Hand className="size-3" aria-hidden />}
      {statusLabel(status)}
    </span>
  )
}

export function ArchivedPill() {
  return <span className={cn(PILL, 'border border-border text-muted-foreground')}>archived</span>
}

const OUTLINE = { x: 0.75, y: 0.75, width: 8.5, height: 8.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }

/** A shape per status, so the status never rests on colour alone. */
function Glyph({ status }: { status: TaskDisplayStatus }) {
  switch (status) {
    case 'running':
      return <circle cx={5} cy={5} r={4.25} fill="currentColor" className="motion-safe:animate-pulse" />
    case 'idle':
      return <rect {...OUTLINE} />
    case 'complete':
      return <rect width={10} height={10} fill="currentColor" />
    case 'error':
      return (
        <>
          <rect width={10} height={10} fill="currentColor" />
          <rect x={4.25} y={1.75} width={1.5} height={4.25} className="fill-background" />
          <rect x={4.25} y={7} width={1.5} height={1.5} className="fill-background" />
        </>
      )
    case 'interrupted':
      return (
        <>
          <rect {...OUTLINE} />
          <path d="M10 0V10H0Z" fill="currentColor" />
        </>
      )
    case 'stopped':
      return (
        <>
          <rect {...OUTLINE} />
          <rect x={3.25} y={3.25} width={3.5} height={3.5} fill="currentColor" />
        </>
      )
    case 'asking':
      return <path d="M0 0H10V7.5H5L2 10V7.5H0Z" fill="currentColor" />
    case 'blocked':
      return <path d="M5 0L10 5L5 10L0 5Z" fill="currentColor" />
  }
}

const LIGHT_SLOT = 'flex size-3 shrink-0 items-center justify-center'

interface StatusLightProps {
  status: TaskDisplayStatus
  /** Where the light sits, so a mod's marker can choose to draw there. */
  place: ModAgentPlace
  subagents?: number
  /** The agent the light stands for, so a mod's marker can draw it as that agent. */
  agent?: { id: string; color: AgentColor | null }
}

/** The status as a small glyph for one-line list rows, named by its label and tooltip. */
export function StatusLight({ status, place, subagents = 0, agent }: StatusLightProps) {
  const glyph = (
    <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden>
      <Glyph status={status} />
    </svg>
  )
  return (
    <span
      role="img"
      aria-label={statusLabel(status)}
      title={statusLightTitle(status, subagents)}
      data-status-light=""
      className={cn(LIGHT_SLOT, GLYPH_COLOUR[status])}
    >
      <ModStatusMarker
        status={status}
        agent={agent === undefined ? null : { id: agent.id, color: agent.color }}
        place={place}
        fallback={glyph}
      />
    </span>
  )
}

export function ArchivedLight() {
  return (
    <span role="img" aria-label="archived" title="archived" className={cn(LIGHT_SLOT, 'text-muted-foreground')}>
      <Archive className="size-3" aria-hidden />
    </span>
  )
}

/** An item in progress takes the agent's own state, so a stalled or waiting item shows as such. */
const inProgressGlyph = (agent: TaskDisplayStatus): TaskDisplayStatus => (agent === 'complete' ? 'idle' : agent)

/** Why an item in progress is not moving, by the agent's status. */
const STALLED: Record<TaskDisplayStatus, string> = {
  running: '',
  idle: 'the agent is idle',
  complete: 'the agent is idle',
  error: "the agent's turn failed",
  stopped: 'the agent was stopped',
  interrupted: 'the agent was cut off',
  asking: 'the agent asks you',
  blocked: 'the agent waits on you',
}

function todoLightLabel(status: TodoStatus, agent: TaskDisplayStatus): string {
  if (status !== 'in_progress') {
    return status
  }
  return agent === 'running' ? 'in progress' : `in progress; ${STALLED[agent]}`
}

/** A todo item's status: the agent's shapes for done and in progress, a quiet dot for pending. */
export function TodoLight({ status, agent }: { status: TodoStatus; agent: TaskDisplayStatus }) {
  const label = todoLightLabel(status, agent)
  const glyph = status === 'completed' ? 'complete' : inProgressGlyph(agent)
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(LIGHT_SLOT, status === 'pending' ? 'text-muted-foreground/70' : GLYPH_COLOUR[glyph])}
    >
      <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden>
        {status === 'pending' ? <circle cx={5} cy={5} r={2} fill="currentColor" /> : <Glyph status={glyph} />}
      </svg>
    </span>
  )
}

const SUBTASK_STYLE: Record<SubtaskStatus, string> = {
  running: 'bg-primary text-primary-foreground animate-pulse',
  completed: 'bg-success/20 text-foreground',
  failed: 'bg-destructive/20 text-destructive',
  stopped: 'bg-muted text-muted-foreground',
  unknown: 'border border-border text-muted-foreground',
}

const UNKNOWN_TITLE = 'The transcript ends before this subagent reported how it ended.'

export function SubtaskPill({ status }: { status: SubtaskStatus }) {
  return (
    <span className={cn(PILL, SUBTASK_STYLE[status])} title={status === 'unknown' ? UNKNOWN_TITLE : undefined}>
      {SUBTASK_LABEL[status]}
    </span>
  )
}

const SUBTASK_GLYPH: Record<Exclude<SubtaskStatus, 'unknown'>, TaskDisplayStatus> = {
  running: 'running',
  completed: 'complete',
  failed: 'error',
  stopped: 'stopped',
}

/** A subagent's status as the same shapes agents use; one that never reported is a dashed square. */
export function SubtaskLight({ status }: { status: SubtaskStatus }) {
  const colour = status === 'unknown' ? 'text-muted-foreground' : GLYPH_COLOUR[SUBTASK_GLYPH[status]]
  return (
    <span
      role="img"
      aria-label={SUBTASK_LABEL[status]}
      title={status === 'unknown' ? UNKNOWN_TITLE : SUBTASK_LABEL[status]}
      className={cn(LIGHT_SLOT, colour)}
    >
      <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden>
        {status === 'unknown' ? (
          <rect {...OUTLINE} strokeDasharray="2 1.5" />
        ) : (
          <Glyph status={SUBTASK_GLYPH[status]} />
        )}
      </svg>
    </span>
  )
}
