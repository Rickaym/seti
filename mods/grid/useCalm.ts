import { useCallback, useState } from 'react'
import { useGridPrefs } from './grid-prefs'

/**
 * Which panels show calm: every one but the focused panel, and that one too until it is used and
 * again once Esc folds it. Focus that moves to another panel opens that panel.
 */
export function useCalm(focused: string | null) {
  const { calm } = useGridPrefs()
  const [rested, setRested] = useState(true)
  const [last, setLast] = useState(focused)
  if (last !== focused) {
    setLast(focused)
    if (last !== null) {
      setRested(false)
    }
  }
  const rest = useCallback(() => {
    setRested(true)
  }, [])
  const wake = useCallback(() => {
    setRested(false)
  }, [])
  return { open: rested ? null : focused, calm, rest, wake }
}
