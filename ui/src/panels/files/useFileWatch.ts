import type { FileStamp } from '@seti/shared'
import { useEffect, useRef } from 'react'
import { openEventStream } from '@/lib/event-stream'
import { filesPath } from '@/panels/files/files-api'

interface Watched {
  taskId: string
  root: string
  path: string
  dotfiles: boolean
}

/** Calls back when the file or folder changes on disk, and on every (re)connect. */
export function useFileWatch(watched: Watched | null, onChange: (stamp: FileStamp | null) => void): void {
  const handler = useRef(onChange)
  useEffect(() => {
    handler.current = onChange
  })
  const key = watched === null ? null : JSON.stringify(watched)
  useEffect(() => {
    if (key === null) {
      return undefined
    }
    const { taskId, root, path, dotfiles } = JSON.parse(key) as Watched
    const deliver = (event: MessageEvent<string>) => {
      handler.current(JSON.parse(event.data) as FileStamp | null)
    }
    const stream = openEventStream(filesPath(taskId, 'watch', { root, path, dotfiles }), {
      events: { ready: deliver, change: deliver },
    })
    return () => {
      stream.close()
    }
  }, [key])
}
