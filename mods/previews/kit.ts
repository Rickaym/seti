import type { ModKit } from '@seti/mod-api'
import { createContext, useContext } from 'react'

export const KitContext = createContext<ModKit | null>(null)

/** Seti's controls, which ui.tsx hands the table and diagram views. */
export function useKit(): ModKit {
  const kit = useContext(KitContext)
  if (kit === null) {
    throw new Error('A preview view needs the kit from ui.tsx')
  }
  return kit
}
