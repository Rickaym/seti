import { useEffect, useRef } from 'react'

export function useSaveShortcut(save: () => void): void {
  const latest = useRef(save)
  useEffect(() => {
    latest.current = save
  }, [save])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        latest.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [])
}
