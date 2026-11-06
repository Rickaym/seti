import { useSyncExternalStore } from 'react'
import { CHORDS, matchesChord } from '@/components/shortcuts/chords'

let open = false
const listeners = new Set<() => void>()

export function setGuideOpen(next: boolean): void {
  if (open !== next) {
    open = next
    for (const listener of listeners) {
      listener()
    }
  }
}

export const openGuide = (): void => {
  setGuideOpen(true)
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useGuideOpen = (): boolean => useSyncExternalStore(subscribe, () => open)

/** Ctrl+/ (Cmd+/ on Apple) opens or closes the shortcut guide anywhere; returns the teardown. */
export function startGuideShortcut(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || !matchesChord(e, CHORDS.guide)) {
      return
    }
    e.preventDefault()
    if (!e.repeat) {
      setGuideOpen(!open)
    }
  }
  window.addEventListener('keydown', onKeyDown)
  return () => {
    window.removeEventListener('keydown', onKeyDown)
  }
}
