import type { WireRow } from '@seti/shared'
import { CircleCheck, History, MessageSquare, Undo2 } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { DOT } from '@/lib/session-labels'
import { ageLabel } from '@/lib/time'
import { toolKind, toolSummary } from '@/lib/tool-summary'
import { RunningFor, Spinner, ToolKindIcon } from '@/panels/tasks/ToolCall'
import { AgentText } from '@/panels/tasks/Transcript'
import { digest, lastOwnMessage, worldState, type ChatItem, type WorkSpan } from '@/panels/tasks/proto/digest'
import { workFacts } from '@/panels/tasks/proto/facts'
import { PersonMessage, StandingFailure, UpdatesStrip } from '@/panels/tasks/proto/parts'

interface Brief {
  said: Extract<ChatItem, { type: 'agent' }> | null
  asked: Extract<ChatItem, { type: 'user' }> | null
  people: Extract<ChatItem, { type: 'person' }>[]
  work: WorkSpan | null
}

/** The agent's last words, the user's last message, who wrote since, and the newest work. */
function briefOf(items: readonly ChatItem[]): Brief {
  const brief: Brief = { said: null, asked: null, people: [], work: null }
  for (const item of items) {
    if (item.type === 'agent') {
      brief.said = item
      brief.people = []
    } else if (item.type === 'user') {
      brief.asked = item
    } else if (item.type === 'person') {
      brief.people.push(item)
    } else if (item.type === 'work' && item.span.calls.length > 0) {
      brief.work = item.span
    }
  }
  return brief
}

const firstLine = (text: string) => text.split('\n').find((line) => line.trim() !== '') ?? ''

/** What the agent does this moment, or how its last turn ended. */
function NowLine({ work, running }: { work: WorkSpan | null; running: boolean }) {
  const live = running ? (work?.live ?? null) : null
  if (live !== null) {
    return (
      <span className="flex min-w-0 items-center gap-2" data-testid="now-line">
        <Spinner />
        <ToolKindIcon kind={toolKind(live.call)} className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-mono text-foreground/90">{toolSummary(live.call)}</span>
        <span className="shrink-0 tabular-nums">
          <RunningFor since={live.since} />
        </span>
      </span>
    )
  }
  if (running) {
    return (
      <span className="flex items-center gap-2" data-testid="now-line">
        <Spinner />
        Thinking
      </span>
    )
  }
  return (
    <span className="flex min-w-0 items-center gap-2" data-testid="now-line">
      <CircleCheck className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">
        {work === null ? 'Idle' : `Done ${ageLabel(work.end)} ago`}
        {work !== null && work.calls.length > 0 && (
          <span className="text-muted-foreground/80">
            {' '}
            {DOT}
            {workFacts(work)}
          </span>
        )}
      </span>
    </span>
  )
}

interface BriefViewProps {
  taskId: string
  messages: readonly WireRow[]
  running: boolean
  /** Permission requests, questions and failures: whatever needs the user, first. */
  needs: ReactNode
  /** The classic transcript, which History opens in place of the brief. */
  history: ReactNode
}

/** B: a brief, not a log: needs, last words and the work now; History holds the rest. */
export function BriefView({ taskId, messages, running, needs, history }: BriefViewProps) {
  const [open, setOpen] = useState(false)
  const items = useMemo(() => digest(messages, running), [messages, running])
  const brief = useMemo(() => briefOf(items), [items])
  const updates = useMemo(() => worldState(messages, lastOwnMessage(messages)), [messages])
  const toggle = (
    <Button
      size="xs"
      variant="ghost"
      aria-pressed={open}
      onClick={() => {
        setOpen(!open)
      }}
    >
      {open ? <Undo2 /> : <History />}
      {open ? 'Brief' : 'History'}
    </Button>
  )
  return (
    <>
      {open ? (
        history
      ) : (
        <section
          aria-label="Brief"
          className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-background px-5 py-4 max-md:px-3 max-md:py-3 in-data-agent-frame:px-3 in-data-agent-frame:py-2"
        >
          {needs}
          {brief.asked !== null && (
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-testid="brief-asked">
              <span className="shrink-0 font-semibold text-primary">You</span>
              <span className="min-w-0 truncate">{firstLine(brief.asked.row.payload.text)}</span>
              <span className="shrink-0 tabular-nums">{ageLabel(brief.asked.row.created_at)}</span>
            </div>
          )}
          {brief.said !== null && (
            <div className="space-y-1" data-testid="brief-said">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <MessageSquare className="size-3.5" aria-hidden />
                <span>Last said {ageLabel(brief.said.row.created_at)} ago</span>
              </div>
              <AgentText text={brief.said.text} />
            </div>
          )}
          {brief.people.map((item) => (
            <PersonMessage key={item.row.id} input={item.input} at={item.row.created_at} />
          ))}
          {brief.work !== null && <StandingFailure span={brief.work} />}
        </section>
      )}
      <div className="flex shrink-0 flex-col gap-1 border-t border-border px-5 py-1.5 text-xs text-muted-foreground max-md:px-3 in-data-agent-frame:px-3">
        <UpdatesStrip taskId={taskId} updates={updates} />
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1">
            <NowLine work={brief.work} running={running} />
          </span>
          {toggle}
        </div>
      </div>
    </>
  )
}
