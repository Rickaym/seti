import { prListSchema, prUrl, type PullRequest, type Task } from '@seti/shared'
import { Link2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { apiGetValid, errorText } from '@/api'
import { ScrollOnHover } from '@/components/ScrollOnHover'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { prShortLabel } from '@/lib/pr-number'
import { CiBadge, ThreadsBadge } from '@/panels/tasks/pr-badges'
import { linkPr } from '@/panels/tasks/pr-links'

const MAX_CHOICES = 30

const taskReposFirst = (slugs: ReadonlySet<string>) => (a: PullRequest, b: PullRequest) =>
  Number(slugs.has(b.repo_slug)) - Number(slugs.has(a.repo_slug))

interface PrPickerProps {
  task: Task
  path: string
  linked: readonly string[]
  onLinked: () => void
}

/** Links an open PR from the registered repos, the agent's own first, or a pasted URL. */
export function PrPicker({ task, path, linked, onLinked }: PrPickerProps) {
  const [prs, setPrs] = useState<PullRequest[] | null>(null)
  const [query, setQuery] = useState('')
  const [pasted, setPasted] = useState('')

  useEffect(() => {
    apiGetValid('/prs?scope=all', prListSchema)
      .then((list) => {
        setPrs(list.repos.flatMap((group) => group.prs))
      })
      .catch((e: unknown) => toast.error(errorText(e)))
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
      .slice(0, MAX_CHOICES)
  }, [prs, query, linked, task.repos])

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
        placeholder="Search open PRs in registered repos"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
        }}
      />
      <ul className="max-h-64 overflow-y-auto border border-border">
        {prs === null && <li className="p-2 text-xs text-muted-foreground">Loading...</li>}
        {prs !== null && choices.length === 0 && (
          <li className="p-2 text-xs text-muted-foreground">No open PRs match.</li>
        )}
        {choices.map((pr) => (
          <li key={pr.key}>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-accent"
              onClick={() => void link(pr.url)}
            >
              <span className="shrink-0 text-muted-foreground">{prShortLabel(pr.url, task.repo_slug)}</span>
              <ScrollOnHover className="flex-1" text={pr.title} />
              <CiBadge state={pr.ci} />
              <ThreadsBadge count={pr.unresolved_threads} />
            </button>
          </li>
        ))}
      </ul>
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
