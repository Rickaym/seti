import { createContext, useCallback, useContext, useMemo, useState } from 'react'

/** A side panel for Files that several framed agents share; one of them holds it at a time. */
export interface FilesDock {
  element: HTMLElement | null
  /** The agent whose Files the dock shows, or null while it is closed. */
  owner: string | null
  claim: (taskId: string) => void
  release: (taskId: string) => void
}

export const FilesDockContext = createContext<FilesDock | null>(null)

export const useFilesDock = (): FilesDock | null => useContext(FilesDockContext)

/** Files for one agent at a time, docked beside its frames rather than squeezed into one. */
export function useFilesDockOwner(): { dock: FilesDock; setElement: (element: HTMLElement | null) => void } {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [owner, setOwner] = useState<string | null>(null)
  const claim = useCallback((taskId: string) => {
    setOwner(taskId)
  }, [])
  const release = useCallback((taskId: string) => {
    setOwner((current) => (current === taskId ? null : current))
  }, [])
  const dock = useMemo(() => ({ element, owner, claim, release }), [element, owner, claim, release])
  return { dock, setElement }
}
