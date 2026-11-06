import { startTransition, useEffect, useId, useState } from 'react'
import { createRenderTurns } from '@/lib/render-turns'

const turns = createRenderTurns()

/** False until this view's turn to render its heavy part, as a transition; `first` jumps ahead. */
export function useRenderTurn(wanted: boolean, first: boolean): boolean {
  const key = useId()
  const [granted, setGranted] = useState(false)
  useEffect(() => {
    if (!wanted || granted) {
      return undefined
    }
    return turns.wait(key, first, () => {
      startTransition(() => {
        setGranted(true)
      })
    })
  }, [key, wanted, granted, first])
  return granted
}
