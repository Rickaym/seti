import { useEffect } from 'react'
import { movedCard } from '@/lib/route'

/** Scrolls to the card an old link to a merged page meant, once the page has loaded. */
export function useMovedCard(loaded: boolean): void {
  const card = movedCard()
  useEffect(() => {
    if (loaded && card !== null) {
      document.getElementById(card)?.scrollIntoView({ block: 'start' })
    }
  }, [loaded, card])
}
