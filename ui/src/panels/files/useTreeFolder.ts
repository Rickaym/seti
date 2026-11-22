import type { TreeListing } from '@seti/shared'
import { useEffect, useState } from 'react'
import { apiGet, errorText } from '@/api'
import { filesPath } from '@/panels/files/files-api'

/** How often a folder whose sizes are still being measured asks again. */
const MEASURING_POLL_MS = 2000

/** Which tree folder to load and the panel's toggles that shape it. */
export interface TreeQuery {
  taskId: string
  root: string
  path: string
  dotfiles: boolean
  setiFiles: boolean
  /** Grows with each Refresh, so every open folder loads again. */
  refreshes: number
  /** Load only while the folder is open; a closed one keeps what it had. */
  enabled: boolean
}

export interface TreeFolder {
  listing: TreeListing | null
  error: string | null
}

/** One level of the tree, asked again every few seconds while its sizes are being measured. */
export function useTreeFolder({ taskId, root, path, dotfiles, setiFiles, refreshes, enabled }: TreeQuery): TreeFolder {
  const [state, setState] = useState<TreeFolder>({ listing: null, error: null })
  const [polls, setPolls] = useState(0)

  useEffect(() => {
    if (!enabled) {
      return undefined
    }
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    apiGet<TreeListing>(filesPath(taskId, 'tree', { root, path, dotfiles, seti_files: setiFiles })).then(
      (listing) => {
        if (!live) {
          return
        }
        setState({ listing, error: null })
        if (listing.measuring) {
          timer = setTimeout(() => {
            setPolls((n) => n + 1)
          }, MEASURING_POLL_MS)
        }
      },
      (e: unknown) => {
        if (live) {
          setState({ listing: null, error: errorText(e) })
        }
      },
    )
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [taskId, root, path, dotfiles, setiFiles, refreshes, enabled, polls])

  return state
}
