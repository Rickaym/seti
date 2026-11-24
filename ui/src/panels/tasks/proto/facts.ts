import type { PrInput, TaskInput } from '@seti/shared'
import {
  CircleCheck,
  CircleX,
  GitMerge,
  GitPullRequestClosed,
  MessageSquareText,
  TriangleAlert,
  Webhook,
  type LucideIcon,
} from 'lucide-react'
import { toolKind, type ToolKind } from '@/lib/tool-summary'
import type { WorkSpan } from '@/panels/tasks/proto/digest'

const NOUNS: Partial<Record<ToolKind, [string, string]>> = {
  command: ['command', 'commands'],
  edit: ['edit', 'edits'],
  read: ['read', 'reads'],
  search: ['search', 'searches'],
  web: ['web call', 'web calls'],
  agent: ['subagent', 'subagents'],
  todo: ['plan update', 'plan updates'],
  mcp: ['tool call', 'tool calls'],
}

export interface KindCount {
  kind: ToolKind
  count: number
  failed: number
}

/** The calls of a stretch by kind, commands first, then by how many. */
export function kindCounts(span: WorkSpan): KindCount[] {
  const counts = new Map<ToolKind, KindCount>()
  span.calls.forEach((call, n) => {
    const kind = toolKind(call)
    const entry = counts.get(kind) ?? { kind, count: 0, failed: 0 }
    entry.count += 1
    entry.failed += span.results[n]?.failed === true ? 1 : 0
    counts.set(kind, entry)
  })
  return [...counts.values()].sort((a, b) => b.count - a.count)
}

/** "12 commands, 3 edits, 2 reads". */
export function workFacts(span: WorkSpan): string {
  return kindCounts(span)
    .map(({ kind, count }) => {
      const [one, many] = NOUNS[kind] ?? ['other call', 'other calls']
      return `${String(count)} ${count === 1 ? one : many}`
    })
    .join(', ')
}

export interface ChipLook {
  icon: LucideIcon
  className: string
  text: string
}

const subjectTag = (subject: string) => subject.replace(/^.*?(#\d+)$/u, '$1')

const PR_CHIPS: Record<PrInput['kind'], Omit<ChipLook, 'text'> & { word: string }> = {
  ci_failed: { icon: CircleX, className: 'text-destructive', word: 'CI failed' },
  ci_passed: { icon: CircleCheck, className: 'text-success', word: 'CI passed' },
  merged: { icon: GitMerge, className: 'text-success', word: 'merged' },
  closed: { icon: GitPullRequestClosed, className: 'text-muted-foreground', word: 'closed, not merged' },
  conflict: { icon: TriangleAlert, className: 'text-warning-text', word: 'conflicts' },
  review: { icon: MessageSquareText, className: 'text-primary', word: 'reviewed' },
  comment: { icon: MessageSquareText, className: 'text-primary', word: 'comment' },
}

export function chipLook(input: TaskInput): ChipLook {
  if (input.source === 'pr') {
    const look = PR_CHIPS[input.kind]
    return { icon: look.icon, className: look.className, text: `${subjectTag(input.subject)} ${look.word}` }
  }
  return { icon: Webhook, className: 'text-muted-foreground', text: input.title }
}

const URGENCY: Record<PrInput['kind'], number> = {
  ci_failed: 0,
  conflict: 0,
  closed: 1,
  merged: 1,
  review: 2,
  comment: 3,
  ci_passed: 4,
}

/** Lower first: what blocks a merge, then a PR's end, then talk, then good news and the rest. */
export const urgency = (input: TaskInput): number => (input.source === 'pr' ? URGENCY[input.kind] : 2)
