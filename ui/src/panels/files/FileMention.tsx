import type { ResolvedPath } from '@seti/shared'
import { Hint } from '@/components/Hint'
import { cn } from '@/lib/utils'
import { FILE_ICONS, fileLook } from '@/panels/files/file-icon'
import { nameOf, parentOf } from '@/panels/files/files-api'

const CHIP = cn(
  'relative inline-flex max-w-full cursor-pointer items-baseline rounded-sm px-[0.3em] align-baseline',
  'bg-primary/10 leading-snug font-medium text-primary transition-colors hover:bg-primary/20',
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
  'pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:inset-y-[calc(50%-22px)]',
)

/** A file named inside a sentence, as a pill like a chat mention: icon, folder and name. */
export function FileMention({
  found,
  shown,
  line,
  onOpen,
}: {
  found: ResolvedPath
  /** The path as the tooltip and the accessible name give it. */
  shown: string
  /** The `:line` or `:line:col` the text gave after the path. */
  line: string | null
  onOpen: () => void
}) {
  const Icon = FILE_ICONS[fileLook(found.path, found.type)]
  const folder = nameOf(parentOf(found.path))
  return (
    <Hint text={shown}>
      <button
        type="button"
        className={CHIP}
        aria-label={`Open ${shown} in Files`}
        data-file-link={found.path}
        data-file-mention=""
        onClick={onOpen}
      >
        <Icon aria-hidden className="mr-[0.3em] size-[1.05em] shrink-0 self-center" />
        {folder !== '' && (
          <span className="min-w-0 shrink-[1000] truncate font-normal text-muted-foreground">{folder}/</span>
        )}
        <span className="min-w-0 truncate">
          {nameOf(found.path)}
          {line !== null && <span className="font-normal text-muted-foreground">{line}</span>}
        </span>
      </button>
    </Hint>
  )
}
