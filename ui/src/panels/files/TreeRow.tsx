import type { FolderSize, GitBadge } from '@seti/shared'
import { ArrowDown, ArrowUp, ChevronRight, GitBranch, type LucideIcon } from 'lucide-react'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { bytesLabel } from '@/panels/resources/format'

/** How far each level indents, and the deepest level that still indents, so phones keep room. */
const INDENT_PX = 12
const INDENT_LEVELS = 8

const plural = (count: number, word: string) => `${String(count)} ${word}${count === 1 ? '' : 's'}`

/** A size as the row shows it: "about" when the walk stopped early, "..." until one finished. */
function sizeText(size: FolderSize | null): string {
  if (size === null) {
    return 'measuring'
  }
  return `${size.capped ? 'about ' : ''}${bytesLabel(size.bytes)}`
}

function sizeDetail(size: FolderSize | null, folder: boolean): string | undefined {
  if (size === null || !folder) {
    return undefined
  }
  return `${size.capped ? 'At least ' : ''}${plural(size.files, 'file')}`
}

function gitDetail(git: GitBadge): string {
  const branch = git.branch === null ? 'Detached HEAD' : `Branch ${git.branch}`
  const changes = git.dirty === 0 ? 'no changes' : plural(git.dirty, 'changed file')
  const upstream =
    git.ahead === null || git.behind === null
      ? 'no upstream'
      : `${String(git.ahead)} ahead and ${String(git.behind)} behind its upstream`
  return `${branch}, ${changes}, ${upstream}`
}

function GitChip({ git }: { git: GitBadge }) {
  return (
    <span
      title={gitDetail(git)}
      className="flex max-w-28 min-w-0 shrink items-center gap-0.5 border border-border px-1 text-2xs text-muted-foreground"
    >
      <GitBranch className="size-3 shrink-0" />
      <span className="truncate">{git.branch ?? 'detached'}</span>
      {git.dirty > 0 && <span className="shrink-0">+{git.dirty}</span>}
      {(git.ahead ?? 0) > 0 && (
        <span className="flex shrink-0 items-center">
          <ArrowUp className="size-3" />
          {git.ahead}
        </span>
      )}
      {(git.behind ?? 0) > 0 && (
        <span className="flex shrink-0 items-center">
          <ArrowDown className="size-3" />
          {git.behind}
        </span>
      )}
    </span>
  )
}

export interface TreeRowProps {
  name: string
  icon: LucideIcon
  level: number
  /** Null for a file, which has nothing to expand. */
  expanded: boolean | null
  size: FolderSize | null
  mtime: string | null
  git: GitBadge | null
  rebuildable: boolean
  /** Shown on hover, such as a root's full path. */
  title?: string
  onClick: () => void
}

/** One folder or file of the tree: name, git badge, rebuildable mark, last change and size. */
export function TreeRow({
  name,
  icon: Icon,
  level,
  expanded,
  size,
  mtime,
  git,
  rebuildable,
  title,
  onClick,
}: TreeRowProps) {
  const label = [name, rebuildable ? 'rebuildable' : null, sizeText(size)].filter((part) => part !== null).join(', ')
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={expanded ?? undefined}
      title={title}
      className="flex w-full min-w-0 items-center gap-1.5 border-b border-border py-1.5 pr-3 text-left hover:bg-accent pointer-coarse:min-h-11"
      style={{ paddingLeft: 8 + Math.min(level, INDENT_LEVELS) * INDENT_PX }}
      onClick={onClick}
    >
      <ChevronRight
        className={cn(
          'size-3.5 shrink-0 text-muted-foreground transition-transform',
          expanded === null && 'invisible',
          expanded === true && 'rotate-90',
        )}
      />
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
      {git !== null && <GitChip git={git} />}
      {rebuildable && <span className="shrink-0 text-2xs text-muted-foreground italic">rebuildable</span>}
      {mtime !== null && (
        <span className="w-14 shrink-0 text-right text-2xs text-muted-foreground tabular-nums max-[22rem]:hidden">
          {relativeTime(mtime)}
        </span>
      )}
      <span
        title={sizeDetail(size, expanded !== null)}
        className="w-20 shrink-0 text-right text-2xs text-muted-foreground tabular-nums"
      >
        {size === null ? '...' : sizeText(size)}
      </span>
    </button>
  )
}
