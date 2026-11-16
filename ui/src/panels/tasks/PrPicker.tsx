import { prListSchema, prUrl, type PrRow, type Task } from '@seti/shared'
import { Link2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { apiGetValid, errorText } from '@/api'
import { ScrollOnHover } from '@/components/ScrollOnHover'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useBatches } from '@/hooks/useBatches'
import { prShortLabel } from '@/lib/pr-number'
import { CiBadge, ThreadsBadge } from '@/panels/tasks/pr-badges'
import { linkPr } from '@/panels/tasks/pr-links'
import { usePrStatuses } from '@/panels/tasks/usePrStatuses'

/** Rows mounted at first; scrolling to the end mounts the next batch and loads its detail. */
const BATCH = 20
/** A list served while a newer one loads is read again this often, this many times. */
const REFRESH_MS = 3000
const REFRESH_TRIES = 10

const taskReposFirst = (slugs: ReadonlySet<string>) => (a: PrRow, b: PrRow) =>
  Number(slugs.has(b.repo_slug)) - Number(slugs.has(a.repo_slug))

interface PrPickerProps {
  task: Task
  path: string
  linked: readonly string[]
  onLinked: () => void
}

/** Links one of the open PRs Seti lists, those of the agent's repos first, or a pasted URL. */
export function PrPicker({ task, path, linked, onLinked }: PrPickerProps) {
  const [prs, setPrs] = useState<PrRow[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [more, setMore] = useState(0)
  const [query, setQuery] = useState('')
  const [pasted, setPasted] = useState('')

  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = (triesLeft: number) => {
      apiGetValid('/prs', prListSchema)
        .then((list) => {
          if (!live) {
            return
          }
          setPrs(list.prs)
          setFailure(list.error)
          setMore(list.more)
          setRefreshing(list.refreshing && triesLeft > 0)
          if (list.refreshing && triesLeft > 0) {
            timer = setTimeout(() => {
              load(triesLeft - 1)
            }, REFRESH_MS)
          }
        })
        .catch((e: unknown) => toast.error(errorText(e)))
    }
    load(REFRESH_TRIES)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [])

  const choices = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const taken = new Set(linked)
    return (prs ?? [])
      .filter((pr) => !taken.has(pr.url))
      .filter(
        (pr) =>
          needle === '' ||
          `${pr.repo_slug}#${String(pr.number)} ${pr.title} ${pr.head_ref}`.toLowerCase().includes(needle),
      )
      .sort(taskReposFirst(new Set(task.repos.map((repo) => repo.slug))))
  }, [prs, query, linked, task.repos])
  const { shown, sentinel } = useBatches(choices.length, BATCH)
  const mounted = useMemo(() => choices.slice(0, shown), [choices, shown])
  const { statuses } = usePrStatuses(useMemo(() => mounted.map((pr) => pr.url), [mounted]))

  const link = async (url: string) => {
    try {
      await linkPr(path, url)
      onLinked()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  const pastedValid = prUrl.safeParse(pasted.trim()).success

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium">Link a pull request</div>
      <Input
        aria-label="Search pull requests"
        placeholder="Search open PRs"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
        }}
      />
      <ul className="max-h-64 overflow-y-auto border border-border">
        {prs === null && <li className="p-2 text-xs text-muted-foreground">Loading...</li>}
        {prs !== null && choices.length === 0 && (
          <li className="p-2 text-xs text-muted-foreground">
            {failure === null ? 'No open PRs match.' : `GitHub gave no PRs: ${failure}`}
          </li>
        )}
        {mounted.map((pr) => (
          <li key={pr.url}>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-accent"
              onClick={() => void link(pr.url)}
            >
              <span className="shrink-0 text-muted-foreground">{prShortLabel(pr.url, task.repo_slug)}</span>
              <ScrollOnHover className="flex-1" text={pr.title} />
              <CiBadge state={statuses.get(pr.url)?.ci ?? pr.ci} />
              <ThreadsBadge count={statuses.get(pr.url)?.unresolved_threads ?? 0} />
            </button>
          </li>
        ))}
        {shown < choices.length && <li ref={sentinel} className="h-6" aria-hidden />}
      </ul>
      {refreshing && <p className="text-xs text-muted-foreground">Refreshing from GitHub</p>}
      {more > 0 && <p className="text-xs text-muted-foreground">{more} more open PRs not listed</p>}
      <div className="flex gap-2">
        <Input
          aria-label="Pull request URL"
          placeholder="or paste https://github.com/owner/repo/pull/123"
          value={pasted}
          onChange={(e) => {
            setPasted(e.target.value)
          }}
        />
        <Button size="sm" disabled={!pastedValid} onClick={() => void link(pasted.trim())}>
          <Link2 />
          Link
        </Button>
      </div>
    </div>
  )
}
