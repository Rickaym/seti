import type { FileRoot } from '@seti/shared'
import { ChevronRight, CornerLeftUp } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'

interface BreadcrumbProps {
  /** The root the folder is in, which the Root select already names; undefined while roots load. */
  root: FileRoot | undefined
  /** The folder shown, '' at the root's top level, where the Root select already says it all. */
  dir: string
  onGo: (dir: string) => void
}

/** Where a subfolder is below its root: Up, then each folder down to this one, each a link back. */
export function Breadcrumb({ root, dir, onGo }: BreadcrumbProps) {
  if (dir === '') {
    return null
  }
  const parts = dir.split('/')
  const parent = parts.slice(0, -1)
  const upTo = parent.at(-1) ?? root?.label ?? 'the top'
  return (
    <nav
      aria-label="Folder"
      className="flex shrink-0 items-center gap-1 border-b border-border py-0.5 pr-3 pl-1.5 text-xs"
    >
      <Hint text={`Up to ${upTo}`}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Up a folder"
          onClick={() => {
            onGo(parent.join('/'))
          }}
        >
          <CornerLeftUp />
        </Button>
      </Hint>
      <ol className="flex min-w-0 flex-wrap items-center gap-0.5">
        {parts.map((part, index) => {
          const to = parts.slice(0, index + 1).join('/')
          return (
            <li key={to} className="flex min-w-0 items-center gap-0.5">
              {index > 0 && <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />}
              {index === parts.length - 1 ? (
                <span aria-current="location" className="font-medium break-all">
                  {part}
                </span>
              ) : (
                <button
                  type="button"
                  className="break-all hover:underline pointer-coarse:min-h-11"
                  onClick={() => {
                    onGo(to)
                  }}
                >
                  {part}
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
