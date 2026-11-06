import type { FileEntry, FileRoot } from '@seti/shared'
import { Link } from 'lucide-react'
import { toast } from 'sonner'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { relativeTime } from '@/lib/time'
import { FILE_ICONS, fileLook } from '@/panels/files/file-icon'
import { bytesLabel } from '@/panels/resources/format'

/** An entry of a folder, or of the recent list with the root it came from. */
export interface ListedEntry extends FileEntry {
  root: string
}

interface FileListProps {
  entries: readonly ListedEntry[]
  roots: readonly FileRoot[]
  /** Show each entry's root and folder, as the recent list does. */
  showWhere: boolean
  empty: string
  onOpen: (entry: ListedEntry) => void
  /** The deep link that opens an entry, which its menu copies. */
  linkOf: (entry: ListedEntry) => string
}

const copyLink = (link: string) => {
  navigator.clipboard.writeText(link).then(
    () => toast.success('Link copied'),
    () => toast.error('Copy failed; open the file and copy the address instead'),
  )
}

export function FileList({ entries, roots, showWhere, empty, onOpen, linkOf }: FileListProps) {
  if (entries.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">{empty}</p>
  }
  const labelOf = (id: string) => roots.find((root) => root.id === id)?.label ?? id
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Files">
      {entries.map((entry) => {
        const Icon = FILE_ICONS[fileLook(entry.name, entry.type)]
        const folder = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
        return (
          <li key={`${entry.root}:${entry.path}`}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 border-b border-border px-3 py-1.5 text-left hover:bg-accent"
                  onClick={() => {
                    onOpen(entry)
                  }}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{entry.name}</span>
                    {showWhere && (
                      <span className="block truncate text-2xs text-muted-foreground">
                        {[labelOf(entry.root), folder].filter((part) => part !== '').join(' / ')}
                      </span>
                    )}
                  </span>
                  {entry.type === 'file' && (
                    <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                      {bytesLabel(entry.size)}
                    </span>
                  )}
                  <span className="w-16 shrink-0 text-right text-2xs text-muted-foreground tabular-nums">
                    {relativeTime(entry.mtime)}
                  </span>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  onSelect={() => {
                    copyLink(linkOf(entry))
                  }}
                >
                  <Link />
                  Copy link
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </li>
        )
      })}
    </ul>
  )
}
