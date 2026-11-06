import type {
  AgentInput,
  AgentInputKind,
  ChannelInput,
  EaNoticeSeverity,
  InputSubtask,
  PrInput,
  PrInputKind,
  SetiInput,
  TaskInput,
  TeamInput,
  WorkspaceInput,
} from '@seti/shared'
import {
  AlertTriangle,
  Bot,
  CircleCheck,
  ChevronDown,
  CircleX,
  Clock,
  ExternalLink,
  FileX,
  GitMerge,
  GitPullRequestClosed,
  Lock,
  MessageSquare,
  MessageSquareText,
  MessagesSquare,
  Webhook,
  type LucideIcon,
} from 'lucide-react'
import { lazy, Suspense } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { navigate } from '@/lib/route'
import { subtaskRouteId } from '@/lib/subtasks'
import { cn } from '@/lib/utils'

const Markdown = lazy(async () => import('@/components/Markdown').then((m) => ({ default: m.Markdown })))

const KIND_STYLES: Record<PrInputKind, { icon: LucideIcon; className: string }> = {
  ci_failed: { icon: CircleX, className: 'border-destructive text-destructive' },
  ci_passed: { icon: CircleCheck, className: 'border-success text-success' },
  review: { icon: MessageSquareText, className: 'border-primary text-primary' },
  comment: { icon: MessageSquare, className: 'border-primary text-primary' },
  conflict: { icon: AlertTriangle, className: 'border-warning text-warning-text' },
  merged: { icon: GitMerge, className: 'border-success text-success' },
  closed: { icon: GitPullRequestClosed, className: 'border-muted-foreground text-muted-foreground' },
}

/** Marks an update the agent has not read yet, or one the user dismissed unread. */
function StateBadge({ input, queued }: { input: TaskInput; queued: boolean }) {
  if (input.dismissed_at !== undefined) {
    return (
      <span className="shrink-0 bg-muted px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground uppercase">
        dismissed
      </span>
    )
  }
  return queued ? (
    <span className="shrink-0 bg-warning/20 px-1.5 py-0.5 text-2xs font-semibold text-foreground uppercase">
      queued
    </span>
  ) : null
}

const TEAM_FROM: Partial<Record<string, string>> = { user: 'you', ea: 'the EA' }

/** A group chat message that mentioned the task or went to every active task. */
function TeamEntry({ input, queued }: { input: TeamInput; queued: boolean }) {
  const from = TEAM_FROM[input.subject] ?? input.subject
  return (
    <div
      className="border-l-2 border-actor-agent bg-muted/40 text-xs"
      data-kind="input"
      data-input={`team-${input.kind}`}
    >
      <div className="flex items-start gap-2 px-2 py-1.5">
        {input.kind === 'direct' ? (
          <Lock className="mt-0.5 size-3.5 shrink-0 text-actor-agent" />
        ) : (
          <MessagesSquare className="mt-0.5 size-3.5 shrink-0 text-actor-agent" />
        )}
        <span className="min-w-0 flex-1 font-medium text-foreground">
          {input.kind === 'direct' ? `Direct message from ${from}` : `Group chat, from ${from}`}
          {input.kind === 'broadcast' && <span className="font-normal text-muted-foreground"> to every agent</span>}
        </span>
        <StateBadge input={input} queued={queued} />
      </div>
      <div className="border-t border-border px-2 py-2 break-words whitespace-pre-wrap text-foreground">
        {input.body}
      </div>
    </div>
  )
}

/** An edit to a workspace file that Seti did not apply, with the reason it gave the agent. */
function WorkspaceEntry({ input, queued }: { input: WorkspaceInput; queued: boolean }) {
  return (
    <div className="border-l-2 border-warning bg-muted/40 text-xs" data-kind="input" data-input="workspace-rejected">
      <div className="flex items-start gap-2 px-2 py-1.5">
        <FileX className="mt-0.5 size-3.5 shrink-0 text-warning-text" />
        <span className="min-w-0 flex-1 font-medium text-foreground">{input.title}</span>
        <StateBadge input={input} queued={queued} />
      </div>
      <div className="border-t border-border px-2 py-2 break-words whitespace-pre-wrap text-foreground">
        {input.body}
      </div>
    </div>
  )
}

/** A denial or an expiry is the user's choice, so it reads muted rather than as a failure. */
const SETI_STYLES: Record<SetiInput['kind'], { icon: LucideIcon; className: string }> = {
  allowed: { icon: CircleCheck, className: 'border-success text-success' },
  denied: { icon: CircleX, className: 'border-border text-muted-foreground' },
  expired: { icon: Clock, className: 'border-border text-muted-foreground' },
}

function SetiEntry({ input, queued }: { input: SetiInput; queued: boolean }) {
  const { icon: Icon, className } = SETI_STYLES[input.kind]
  return (
    <div
      className={cn('border-l-2 bg-muted/40 text-xs', className)}
      data-kind="input"
      data-input={`seti-${input.kind}`}
    >
      <div className="flex items-start gap-2 px-2 py-1.5">
        <Icon className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 font-medium text-foreground">{input.title}</span>
        <StateBadge input={input} queued={queued} />
      </div>
      <div className="border-t border-border px-2 py-2 break-words whitespace-pre-wrap text-foreground">
        {input.body}
      </div>
    </div>
  )
}

const SEVERITY_STYLES: Record<EaNoticeSeverity, string> = {
  critical: 'border-destructive text-destructive',
  warning: 'border-warning text-warning-text',
  success: 'border-success text-success',
  info: 'border-primary text-primary',
}

/** An event from a webhook channel the task subscribes to; its text came from outside. */
function ChannelEntry({ input, queued }: { input: ChannelInput; queued: boolean }) {
  return (
    <div
      className={cn('border-l-2 bg-muted/40 text-xs', SEVERITY_STYLES[input.severity])}
      data-kind="input"
      data-input="channel"
    >
      <div className="flex items-start gap-2 px-2 py-1.5">
        <Webhook className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 text-foreground">
          <span className="font-medium">{input.title}</span>
          <span className="block text-muted-foreground">
            {input.channel}, from {input.subject}
            {input.kind !== '' && <span className="font-mono"> {input.kind}</span>}
          </span>
        </span>
        <StateBadge input={input} queued={queued} />
        {input.url !== null && (
          <a
            href={input.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${input.title}`}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
      {input.body !== '' && (
        <div className="max-h-72 overflow-y-auto border-t border-border px-2 py-2 break-words whitespace-pre-wrap text-foreground">
          {input.body}
        </div>
      )}
    </div>
  )
}

const AGENT_STYLES: Record<AgentInputKind, string> = {
  idle: 'border-success text-success',
  error: 'border-destructive text-destructive',
  stopped: 'border-muted-foreground text-muted-foreground',
}

/** Another agent ended a turn this agent waited for; the body is its final message. */
function AgentEntry({ input, queued }: { input: AgentInput; queued: boolean }) {
  return (
    <div
      className={cn('border-l-2 bg-muted/40 text-xs', AGENT_STYLES[input.kind])}
      data-kind="input"
      data-input={`agent-${input.kind}`}
    >
      <div className="flex items-start gap-2 px-2 py-1.5">
        <Bot className="mt-0.5 size-3.5 shrink-0" />
        <button
          type="button"
          className="min-w-0 flex-1 text-left font-medium text-foreground hover:underline"
          onClick={() => {
            navigate('agents', input.task_id)
          }}
        >
          {input.title}
        </button>
        <StateBadge input={input} queued={queued} />
      </div>
      {input.body !== '' && (
        <div className="max-h-72 overflow-y-auto border-t border-border px-2 py-2 text-foreground">
          <Suspense fallback={<div className="whitespace-pre-wrap">{input.body}</div>}>
            <Markdown text={input.body} />
          </Suspense>
        </div>
      )}
    </div>
  )
}

/** The subagent a PR update was routed to, through its parent agent; opens it. */
function SubtaskChip({ taskId, subtask }: { taskId: string; subtask: InputSubtask }) {
  const agent = subtask.agent_id === null ? '' : ` (${subtask.agent_id})`
  return (
    <button
      type="button"
      className="relative flex max-w-40 min-w-0 shrink items-center gap-1 bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground hover:text-foreground pointer-coarse:after:absolute pointer-coarse:after:-inset-2"
      title={`For subagent ${subtask.description}, handed to the parent agent with SendMessage${agent}`}
      data-testid="input-subtask"
      onClick={() => {
        navigate('agents', subtaskRouteId(taskId, subtask.tool_use_id))
      }}
    >
      <Bot className="size-3 shrink-0" />
      <span className="truncate">{subtask.description}</span>
    </button>
  )
}

interface PrEntryProps {
  taskId: string
  input: PrInput
  queued: boolean
}

/** A PR update shows its title; the body stays folded until opened. */
function PrEntry({ taskId, input, queued }: PrEntryProps) {
  const style = KIND_STYLES[input.kind]
  const Icon = style.icon
  const heading = (
    <>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 font-medium text-foreground">{input.title}</span>
    </>
  )
  return (
    <Collapsible
      className={cn('group/pr border-l-2 bg-muted/40 text-xs', style.className)}
      data-kind="input"
      data-input={input.kind}
    >
      <div className="flex flex-wrap items-center gap-x-2 pr-2">
        {input.body === '' ? (
          <div className="flex min-w-0 flex-[1_1_14rem] items-start gap-2 py-1.5 pl-2">{heading}</div>
        ) : (
          <CollapsibleTrigger className="flex min-w-0 flex-[1_1_14rem] items-start gap-2 py-1.5 pl-2 text-left hover:bg-muted/60 pointer-coarse:min-h-11 pointer-coarse:items-center">
            {heading}
            <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/pr:rotate-180 pointer-coarse:mt-0" />
          </CollapsibleTrigger>
        )}
        <div className="ml-auto flex max-w-full min-w-0 items-center gap-2 py-1 pl-2">
          {input.subtask !== undefined && <SubtaskChip taskId={taskId} subtask={input.subtask} />}
          <StateBadge input={input} queued={queued} />
          {input.url !== null && (
            <a
              href={input.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${input.subject} on GitHub`}
              className="relative shrink-0 text-muted-foreground hover:text-foreground pointer-coarse:after:absolute pointer-coarse:after:-inset-3"
            >
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
      </div>
      <CollapsibleContent className="max-h-72 overflow-y-auto border-t border-border px-2 py-2 text-foreground">
        <Suspense fallback={<div className="whitespace-pre-wrap">{input.body}</div>}>
          <Markdown text={input.body} html />
        </Suspense>
      </CollapsibleContent>
    </Collapsible>
  )
}

function SourceEntry({ taskId, input, queued }: { taskId: string; input: TaskInput; queued: boolean }) {
  switch (input.source) {
    case 'team':
      return <TeamEntry input={input} queued={queued} />
    case 'workspace':
      return <WorkspaceEntry input={input} queued={queued} />
    case 'channel':
      return <ChannelEntry input={input} queued={queued} />
    case 'pr':
      return <PrEntry taskId={taskId} input={input} queued={queued} />
    case 'agent':
      return <AgentEntry input={input} queued={queued} />
    case 'seti':
      return <SetiEntry input={input} queued={queued} />
  }
}

/** An update from outside the conversation, marked while unread or once dismissed. */
export function InputEntry({ taskId, input, queued }: { taskId: string; input: TaskInput; queued: boolean }) {
  const entry = <SourceEntry taskId={taskId} input={input} queued={queued} />
  return input.dismissed_at === undefined ? (
    entry
  ) : (
    <div className="opacity-60" data-dismissed>
      {entry}
    </div>
  )
}
