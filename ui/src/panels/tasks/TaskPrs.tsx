import { type LinkedPrState, type PullRequest, type SubtaskBrief, type TaskListEntry } from '@seti/shared'
import { GitPullRequest, Plus, X } from 'lucide-react'
import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Hint } from '@/components/Hint'
import { ScrollOnHover } from '@/components/ScrollOnHover'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { refreshTasks } from '@/hooks/useTasks'
import { TOUCH_TARGET } from '@/lib/touch'
import { cn } from '@/lib/utils'
import { MoreLinkedPrs } from '@/panels/tasks/LinkedPrList'
import { PrChips } from '@/panels/tasks/PrChips'
import { FailingCiBadge, FailingCiButton, type PrAgent } from '@/panels/tasks/PrCiFailure'
import { PrPicker } from '@/panels/tasks/PrPicker'
import { orderLinkedPrs, type LinkedPr } from '@/panels/tasks/linked-prs'
import { CiBadge, Tag, ThreadsBadge } from '@/panels/tasks/pr-badges'
import { prsPath, unlinkWithUndo } from '@/panels/tasks/pr-links'
import { usePrStatuses } from '@/panels/tasks/usePrStatuses'

/** Subagent headers show up to this many PRs before the rest fold into the list. */
const SUBTASK_SHOWN_PRS = 4

interface ChipProps {
  item: LinkedPr
  path: string
  /** What unlinking detaches the PR from, for its hint. */
  owner: string
  /** The agent that Fix CI asks. */
  agent: PrAgent
  onChanged: () => void
  /** Same size, without hints or popovers, for the ruler that measures what fits. */
  bare?: boolean
}

const NO_STATUS: Record<LinkedPr['group'], string> = {
  fix: '',
  open: 'Not open, or not in a registered repo',
  merged: 'Merged',
  closed: 'Closed',
}

function PrChip({ item, path, owner, agent, onChanged, bare = false }: ChipProps) {
  const { pr, label } = item
  const unlink = (
    <button
      type="button"
      className={TOUCH_TARGET}
      aria-label={`Unlink ${label}`}
      onClick={() => void unlinkWithUndo(path, item.url, label, onChanged)}
    >
      <X className="size-3" />
    </button>
  )
  const failing = (open: PullRequest) =>
    bare ? <FailingCiButton label={label} /> : <FailingCiBadge pr={open} label={label} agent={agent} />
  return (
    <span
      className="flex min-w-0 shrink-0 items-center gap-1.5 last:shrink pointer-coarse:gap-0.5"
      role="group"
      aria-label={`Pull request ${label}`}
    >
      <GitPullRequest className="size-3 shrink-0" />
      <a
        className={cn('min-w-0 hover:underline pointer-coarse:-my-3.5 pointer-coarse:py-3.5', pr && 'text-primary')}
        href={item.url}
        target="_blank"
        rel="noreferrer"
        title={pr?.title ?? NO_STATUS[item.group]}
      >
        <ScrollOnHover text={label} title={null} />
      </a>
      {pr && (pr.ci === 'failure' ? failing(pr) : <CiBadge state={pr.ci} />)}
      {pr && <ThreadsBadge count={pr.unresolved_threads} bare={bare} />}
      {pr?.mergeable === 'conflicting' && <Tag tone="failure">conflicts</Tag>}
      {pr && <PrChips pr={pr} />}
      {bare ? unlink : <Hint text={`Unlink ${label} from ${owner}`}>{unlink}</Hint>}
    </span>
  )
}

const gapOf = (node: Element) => {
  const gap = Number.parseFloat(getComputedStyle(node).columnGap)
  return Number.isNaN(gap) ? 0 : gap
}

/** How many ruler chips fit the row beside the "+N more" button that count needs, possibly none. */
function useFittedCount(candidates: number) {
  const row = useRef<HTMLDivElement>(null)
  const chips = useRef<HTMLDivElement>(null)
  const mores = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState(candidates)
  useLayoutEffect(() => {
    const rowNode = row.current
    const chipsNode = chips.current
    const moresNode = mores.current
    if (rowNode === null || chipsNode === null || moresNode === null) {
      return
    }
    const measure = () => {
      const gap = gapOf(chipsNode)
      const room = rowNode.clientWidth
      const more = Array.from(moresNode.children, (node) => node.getBoundingClientRect().width)
      let used = 0
      let count = 0
      for (const [index, chip] of Array.from(chipsNode.children).entries()) {
        used += (index === 0 ? 0 : gap) + chip.getBoundingClientRect().width
        const tail = more[index + 1] ?? 0
        if (used + (tail > 0 ? gap + tail : 0) > room) {
          break
        }
        count = index + 1
      }
      setFit(count)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(rowNode)
    observer.observe(chipsNode)
    observer.observe(moresNode)
    return () => {
      observer.disconnect()
    }
  }, [candidates])
  return { row, chips, mores, fit: Math.min(fit, candidates) }
}

interface ChipRowProps {
  urls: readonly string[]
  states: Readonly<Record<string, LinkedPrState>>
  homeSlug: string | null
  path: string
  owner: string
  agent: PrAgent
  /** Most chips the row shows; fewer when they do not fit on one line. */
  limit: number
  /** The control that links another PR, after the chips. */
  picker: ReactNode
  className?: string
  testId?: string
}

/** Linked PRs on one line, the most pressing first; the rest open from "+N more". */
function PrChipRow({ urls, states, homeSlug, path, owner, agent, limit, picker, className, testId }: ChipRowProps) {
  const { statuses, reload } = usePrStatuses(urls)
  const ordered = useMemo(() => orderLinkedPrs(urls, statuses, states, homeSlug), [urls, statuses, states, homeSlug])
  const candidates = ordered.slice(0, limit)
  const { row, chips, mores, fit } = useFittedCount(candidates.length)
  const chip = (item: LinkedPr) => (
    <PrChip key={item.url} item={item} path={path} owner={owner} agent={agent} onChanged={refreshTasks} />
  )
  const measured = (item: LinkedPr) => (
    <PrChip key={item.url} item={item} path={path} owner={owner} agent={agent} onChanged={refreshTasks} bare />
  )
  const more = (shown: number, bare: boolean) => {
    const hidden = ordered.length - shown
    if (hidden === 0) {
      return bare ? <span key={shown} /> : null
    }
    return (
      <MoreLinkedPrs
        key={shown}
        prs={ordered}
        hidden={hidden}
        shown={shown}
        toFix={ordered.slice(shown).filter((item) => item.group === 'fix').length}
        path={path}
        owner={owner}
        agent={agent}
        onChanged={refreshTasks}
        onOpen={reload}
        bare={bare}
      />
    )
  }

  return (
    <div className={cn('flex h-5 min-w-0 items-center gap-x-3', className)} data-testid={testId}>
      {candidates.length > 0 && (
        <div ref={row} className="relative flex min-w-0 flex-1 items-center gap-x-3">
          {candidates.slice(0, fit).map(chip)}
          {more(fit, false)}
          <div className="pointer-events-none invisible absolute inset-0 overflow-hidden" aria-hidden inert>
            <div ref={chips} className="flex w-max items-center gap-x-3">
              {candidates.map(measured)}
            </div>
            <div ref={mores} className="flex w-max flex-col items-start">
              {Array.from({ length: candidates.length + 1 }, (_, shown) => more(shown, true))}
            </div>
          </div>
        </div>
      )}
      {picker}
    </div>
  )
}

/** The task's pull requests with live status on one line, and a picker to link more. */
export const TaskPrs = memo(function TaskPrsView({ task, limit }: { task: TaskListEntry; limit: number }) {
  const [open, setOpen] = useState(false)
  const path = prsPath(task.id)
  const picker = (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint text="Link PR">
        <PopoverTrigger asChild>
          <button type="button" className={cn(TOUCH_TARGET, 'shrink-0')} aria-label="Link PR">
            <Plus className="size-3.5" />
          </button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="start" className="w-96">
        <PrPicker
          task={task}
          path={path}
          linked={task.pr_urls}
          onLinked={() => {
            setOpen(false)
            refreshTasks()
          }}
        />
      </PopoverContent>
    </Popover>
  )
  return (
    <PrChipRow
      urls={task.pr_urls}
      states={task.pr_states.by_url}
      homeSlug={task.repo_slug}
      path={path}
      owner="this agent"
      agent={task}
      limit={limit}
      picker={picker}
      className={task.pr_urls.length > 0 ? 'min-w-[min(50%,16rem)] flex-1' : 'shrink-0'}
    />
  )
})

/** The PRs linked to one subagent, and a picker that links one of any PR, the task's included. */
export function SubtaskPrs({ task, subtask }: { task: TaskListEntry; subtask: SubtaskBrief }) {
  const [open, setOpen] = useState(false)
  const path = prsPath(task.id, subtask.tool_use_id)
  const picker = (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint text="Link a PR to this subagent; updates on it name the subagent to the parent agent">
        <PopoverTrigger asChild>
          <button
            type="button"
            className="-my-1 flex min-h-6 shrink-0 items-center gap-0.5 hover:text-foreground pointer-coarse:-my-2.5 pointer-coarse:py-2.5"
            aria-label="Link PR"
          >
            <Plus className="size-3.5" />
            {subtask.pr_urls.length === 0 && 'Link PR'}
          </button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="start" className="w-96">
        <PrPicker
          task={task}
          path={path}
          linked={subtask.pr_urls}
          onLinked={() => {
            setOpen(false)
            refreshTasks()
          }}
        />
      </PopoverContent>
    </Popover>
  )
  return (
    <PrChipRow
      urls={subtask.pr_urls}
      states={task.pr_states.by_url}
      homeSlug={task.repo_slug}
      path={path}
      owner="this subagent"
      agent={task}
      limit={SUBTASK_SHOWN_PRS}
      picker={picker}
      className="text-xs text-muted-foreground"
      testId="subtask-prs"
    />
  )
}
