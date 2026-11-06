import { useCallback, useEffect, useRef, useState } from 'react'
import { drafts } from '@/lib/drafts'

const SAVE_DELAY_MS = 400

/** Text kept under `key` across views and reloads; a null key keeps it for this view only. */
export function useDraft(key: string | null, fallback = ''): [string, (text: string) => void] {
  const [text, setText] = useState(() => {
    const saved = key === null ? '' : drafts.read(key)
    return saved === '' ? fallback : saved
  })
  const unsaved = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const save = useCallback(() => {
    clearTimeout(timer.current)
    if (key !== null && unsaved.current !== null) {
      drafts.write(key, unsaved.current)
      unsaved.current = null
    }
  }, [key])

  useEffect(() => {
    window.addEventListener('pagehide', save)
    return () => {
      window.removeEventListener('pagehide', save)
      save()
    }
  }, [save])

  const update = useCallback(
    (next: string) => {
      setText(next)
      if (key === null) {
        return
      }
      unsaved.current = next
      clearTimeout(timer.current)
      if (next.trim() === '') {
        save()
      } else {
        timer.current = setTimeout(save, SAVE_DELAY_MS)
      }
    },
    [key, save],
  )

  return [text, update]
}
