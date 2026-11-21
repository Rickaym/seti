import { FILES_TREE_ROOT, type FileRoot } from '@seti/shared'
import type { ComponentProps } from 'react'
import { FileList, type ListedEntry } from '@/panels/files/FileList'
import { FileTree } from '@/panels/files/FileTree'
import { filesLinkUrl } from '@/panels/files/files-api'

/** The recent files are the list's own place, not a root of the agent. */
export const RECENT = 'recent'

export interface Listing {
  entries: ListedEntry[] | null
  error: string | null
  refresh: () => void
}

function ListBody({
  taskId,
  listing,
  roots,
  recent,
  onOpen,
}: {
  taskId: string
  listing: Listing
  roots: readonly FileRoot[]
  recent: boolean
  onOpen: (entry: ListedEntry) => void
}) {
  if (listing.error !== null) {
    return <p className="p-4 text-sm text-destructive">{listing.error}</p>
  }
  if (listing.entries === null) {
    return <p className="p-4 text-sm text-muted-foreground">Loading...</p>
  }
  return (
    <FileList
      entries={listing.entries}
      roots={roots}
      showWhere={recent}
      empty={recent ? 'No files changed since the agent started.' : 'This folder is empty.'}
      onOpen={onOpen}
      linkOf={(entry) => filesLinkUrl(taskId, entry)}
    />
  )
}

interface BrowseProps {
  taskId: string
  listing: Listing
  roots: readonly FileRoot[]
  /** The root the list shows: a root's id, the recent files or the tree. */
  place: string
  /** A file is open; the tree stays mounted behind it so its open folders stay open. */
  hidden: boolean
  tree: Pick<ComponentProps<typeof FileTree>, 'dotfiles' | 'setiFiles' | 'refreshes'>
  onOpen: (entry: ListedEntry) => void
}

/** The tree of every root, or the recent files or one folder, under the open file if any. */
export function BrowseBody({ taskId, listing, roots, place, hidden, tree, onOpen }: BrowseProps) {
  if (place === FILES_TREE_ROOT) {
    return (
      <div className={hidden ? 'hidden' : 'contents'}>
        <FileTree taskId={taskId} roots={roots} {...tree} onOpenFile={onOpen} />
      </div>
    )
  }
  return hidden ? null : (
    <ListBody taskId={taskId} listing={listing} roots={roots} recent={place === RECENT} onOpen={onOpen} />
  )
}
