import { CircleX, GitMerge, GitPullRequest, GitPullRequestClosed, List, Plus, X, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Hint } from '@/components/Hint'
import { ScrollOnHover } from '@/components/ScrollOnHover'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useNarrow } from '@/hooks/useMedia'
import { refreshTasks } from '@/hooks/useTasks'
import { relativeTime } from '@/lib/time'
import { TOUCH_TARGET } from '@/lib/touch'
import { cn } from '@/lib/utils'
import { PrChips } from '@/panels/tasks/PrChips'
import { FailingChecks } from '@/panels/tasks/PrCiFailure'
import { filterLinkedPrs, LINKED_PR_GROUPS, type LinkedPr, type LinkedPrGroup } from '@/panels/tasks/linked-prs'
import { CiBadge, Tag, ThreadsBadge } from '@/panels/tasks/pr-badges'
import { keepForToasts, unlinkWithUndo } from '@/panels/tasks/pr-links'

/** Rows mounted at first; scrolling to the end mounts the next batch, so 500 links open fast. */
const BATCH = 60

const GROUP: Record<LinkedPrGroup, { title: string; icon: LucideIcon; className: string }> = {
  fix: { title: 'Needs a fix', icon: CircleX, className: 'text-destructive' },
  open: { title: 'Open', icon: GitPullRequest, className: 'text-success' },
  merged: { title: 'Merged', icon: GitMerge, className: 'text-primary' },
  closed: { title: 'Closed', icon: GitPullRequestClosed, className: 'text-muted-foreground' },
}

interface RowProps {
  item: LinkedPr
  path: string
  owner: string
  onChanged: () => void
  onStart: () => void
}

/** A row's second line: where the PR lives, its CI, threads, conflicts and last update. */
function RowMeta({ item: { pr, slug, number } }: { item: LinkedPr }) {
  return (
    <span className="mt-0.5 flex items-center gap-1 pl-5 text-2xs text-muted-foreground">
      <ScrollOnHover text={`${slug}#${String(number)}`} />
      {pr !== null && (
        <>
          <CiBadge state={pr.ci} />
          <ThreadsBadge count={pr.unresolved_threads} />
        </>
      )}
      {pr?.mergeable === 'conflicting' && <Tag tone="failure">conflicts</Tag>}
      {pr !== null && <span className="ml-auto shrink-0 pl-1">{relativeTime(pr.updated_at)}</span>}
    </span>
  )
}

function LinkedPrRow({ item, path, owner, onChanged, onStart }: RowProps) {
  const { pr } = item
  const { icon: Icon, className, title } = GROUP[item.group]
  const draft = pr?.draft === true
  return (
    <li className="border-b border-border last:border-b-0" aria-label={`Pull request ${item.label}`}>
      <div className="flex items-center gap-1 pr-2 pointer-coarse:min-h-11">
        <a
          className="min-w-0 flex-1 px-3 py-1.5 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
          href={item.url}
          target="_blank"
          rel="noreferrer"
          title="Open on GitHub"
        >
          <span className="flex items-center gap-1.5">
            <Icon
              className={cn('size-3.5 shrink-0', draft ? 'text-muted-foreground' : className)}
              aria-label={draft ? 'Draft' : title}
            />
            <ScrollOnHover
              className={cn((pr === null || draft) && 'text-muted-foreground')}
              text={pr?.title ?? (item.group === 'open' ? 'No status: not in a registered repo' : title)}
            />
          </span>
          <RowMeta item={item} />
        </a>
        {pr !== null && <PrChips pr={pr} />}
        <Hint text={`Unlink ${item.label} from ${owner}`}>
          <button
            type="button"
            className={TOUCH_TARGET}
            aria-label={`Unlink ${item.label}`}
            onClick={() => void unlinkWithUndo(path, item.url, item.label, onChanged)}
          >
            <X className="size-3" />
          </button>
        </Hint>
      </div>
      {pr?.ci === 'failure' && (
        <div className="pr-3 pb-2 pl-8">
          <FailingChecks pr={pr} onStart={onStart} />
        </div>
      )}
    </li>
  )
}

/** Grows the mounted row count by a batch each time the sentinel scrolls into view. */
function useBatches(total: number) {
  const [shown, setShown] = useState(BATCH)
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = sentinel.current
    if (node === null || shown >= total) {
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setShown((n) => n + BATCH)
      }
    })
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [shown, total])
  return { shown, sentinel }
}

interface RowsProps {
  matches: readonly LinkedPr[]
  path: string
  owner: string
  onChanged: () => void
  onStart: () => void
}

function GroupedRows({ matches, path, owner, onChanged, onStart }: RowsProps) {
  const { shown, sentinel } = useBatches(matches.length)
  const mounted = matches.slice(0, shown)
  const groups = LINKED_PR_GROUPS.map((group) => ({
    group,
    count: matches.filter((item) => item.group === group).length,
    rows: mounted.filter((item) => item.group === group),
  })).filter(({ rows }) => rows.length > 0)
  return (
    <>
      {groups.map(({ group, count, rows }) => (
        <section key={group} aria-label={GROUP[group].title}>
          <h3 className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-popover px-3 py-1 text-2xs font-semibold text-muted-foreground uppercase">
            {GROUP[group].title}
            <span className="tabular-nums">{count}</span>
          </h3>
          <ul className="text-xs">
            {rows.map((item) => (
              <LinkedPrRow
                key={item.url}
                item={item}
                path={path}
                owner={owner}
                onChanged={onChanged}
                onStart={onStart}
              />
            ))}
          </ul>
        </section>
      ))}
      {shown < matches.length && <div ref={sentinel} className="h-8" />}
    </>
  )
}

interface ListProps {
  prs: readonly LinkedPr[]
  path: string
  owner: string
  onChanged: () => void
  onStart: () => void
}

function LinkedPrList({ prs, ...rest }: ListProps) {
  const [query, setQuery] = useState('')
  const matches = useMemo(() => filterLinkedPrs(prs, query), [prs, query])
  return (
    <>
      <div className="shrink-0 border-b border-border p-2">
        <Input
          aria-label="Filter linked PRs"
          placeholder="Filter by number, title or repo"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
          }}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="linked-pr-list">
        {matches.length === 0 && (
          <p className="p-3 text-xs text-muted-foreground">No linked PR matches &ldquo;{query.trim()}&rdquo;.</p>
        )}
        <GroupedRows key={query} matches={matches} {...rest} />
      </div>
    </>
  )
}

interface SheetProps {
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** A control beside the title, before Close. */
  action?: ReactNode
  children: ReactNode
}

/** A phone's bottom sheet of linked PRs. */
function LinkedPrsSheet({ title, open, onOpenChange, action, children }: SheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        aria-describedby={undefined}
        className="max-h-[calc(var(--app-height,100dvh)-env(safe-area-inset-top)-1.5rem)] gap-0"
        onPointerDownOutside={keepForToasts}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border py-1 pr-1 pl-4">
          <SheetTitle className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</SheetTitle>
          {action}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close linked PRs"
            onClick={() => {
              onOpenChange(false)
            }}
          >
            <X />
          </Button>
        </div>
        {children}
      </SheetContent>
    </Sheet>
  )
}

interface AgentPrsSheetProps {
  prs: readonly LinkedPr[]
  path: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The picker that links another PR; it calls `done` once one is linked. */
  picker: (done: () => void) => ReactNode
}

/** Every PR linked to an agent as a phone sheet, to link, open, unlink or fix. */
export function AgentPrsSheet({ prs, path, open, onOpenChange, picker }: AgentPrsSheetProps) {
  const [linking, setLinking] = useState(false)
  const close = () => {
    onOpenChange(false)
  }
  const link = (
    <Button
      variant="ghost"
      size="sm"
      aria-expanded={linking}
      onClick={() => {
        setLinking((was) => !was)
      }}
    >
      <Plus />
      Link PR
    </Button>
  )
  return (
    <LinkedPrsSheet title={`Linked PRs (${String(prs.length)})`} open={open} onOpenChange={onOpenChange} action={link}>
      {linking && (
        <div className="shrink-0 border-b border-border p-3">
          {picker(() => {
            setLinking(false)
          })}
        </div>
      )}
      {prs.length > 0 && (
        <LinkedPrList prs={prs} path={path} owner="this agent" onChanged={refreshTasks} onStart={close} />
      )}
    </LinkedPrsSheet>
  )
}

interface MoreProps {
  prs: readonly LinkedPr[]
  /** How many of them the row leaves out. */
  hidden: number
  /** How many chips the row shows; with none, the button names the total instead. */
  shown: number
  /** Left-out PRs that need a fix, flagged on the button. */
  toFix: number
  path: string
  owner: string
  onChanged: () => void
  onOpen: () => void
  /** The button alone, for the ruler that measures what fits. */
  bare?: boolean
}

/** "+N more": every linked PR in a filterable list, a popover on desktop and a sheet on phones. */
export function MoreLinkedPrs({ prs, hidden, shown, toFix, path, owner, onChanged, onOpen, bare = false }: MoreProps) {
  const narrow = useNarrow()
  const [open, setOpen] = useState(false)
  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (next) {
      onOpen()
    }
  }
  const close = () => {
    setOpen(false)
  }
  const title = `Linked PRs (${String(prs.length)})`
  const count = `${String(prs.length)} ${prs.length === 1 ? 'PR' : 'PRs'}`
  const trigger: ReactNode = (
    <button
      type="button"
      className="-my-1 flex min-h-6 shrink-0 items-center gap-1 whitespace-nowrap text-primary hover:underline pointer-coarse:-my-2.5 pointer-coarse:min-h-11"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={
        narrow
          ? () => {
              changeOpen(true)
            }
          : undefined
      }
    >
      <List className="size-3" />
      {shown === 0 ? count : `+${String(hidden)} more`}
      {toFix > 0 && <Tag tone="failure">{`${String(toFix)} to fix`}</Tag>}
    </button>
  )
  if (bare) {
    return trigger
  }
  const list = <LinkedPrList prs={prs} path={path} owner={owner} onChanged={onChanged} onStart={close} />

  if (narrow) {
    return (
      <>
        {trigger}
        <LinkedPrsSheet title={title} open={open} onOpenChange={changeOpen}>
          {list}
        </LinkedPrsSheet>
      </>
    )
  }
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <Hint text="Every linked PR, to filter, open or unlink">
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      </Hint>
      <PopoverContent
        align="start"
        aria-label={title}
        className="flex max-h-[min(32rem,var(--radix-popover-content-available-height))] w-[30rem] max-w-[calc(100vw-1rem)] flex-col p-0"
        onPointerDownOutside={keepForToasts}
        onFocusOutside={keepForToasts}
      >
        <div className="shrink-0 border-b border-border px-3 py-1.5 text-xs font-medium">{title}</div>
        {list}
      </PopoverContent>
    </Popover>
  )
}
