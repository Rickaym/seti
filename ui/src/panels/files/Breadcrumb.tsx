import type { FileRoot } from '@seti/shared'
import { ChevronRight } from 'lucide-react'

interface BreadcrumbProps {
  root: FileRoot | undefined
  /** The tree of every root is showing, which has no one folder to name. */
  tree: boolean
  dir: string
  onGo: (dir: string) => void
}

/** Where the list is: the root and each folder down to the one shown, each a link back up. */
export function Breadcrumb({ root, tree, dir, onGo }: BreadcrumbProps) {
  if (tree) {
    return <span className="text-muted-foreground">Every folder, with its size</span>
  }
  if (root === undefined) {
    return <span className="text-muted-foreground">Changed since the agent started</span>
  }
  const parts = dir === '' ? [] : dir.split('/')
  return (
    <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center gap-0.5">
      <button
        type="button"
        className="hover:underline"
        title={root.path}
        onClick={() => {
          onGo('')
        }}
      >
        {root.label}
      </button>
      {parts.map((part, index) => {
        const to = parts.slice(0, index + 1).join('/')
        return (
          <span key={to} className="flex items-center gap-0.5">
            <ChevronRight className="size-3 text-muted-foreground" />
            <button
              type="button"
              className="hover:underline"
              onClick={() => {
                onGo(to)
              }}
            >
              {part}
            </button>
          </span>
        )
      })}
    </nav>
  )
}
