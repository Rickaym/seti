import { type ModPolled, type UiModApi, type ChangelogStatus } from '@seti/mod-api'
import { createContext, useContext } from 'react'

/** The mod API and the status poll the views of this mod share. */
export interface WhatsNew {
  api: UiModApi
  status: ModPolled<ChangelogStatus>
}

export const WhatsNewContext = createContext<WhatsNew | null>(null)

export function useWhatsNew(): WhatsNew {
  const context = useContext(WhatsNewContext)
  if (context === null) {
    throw new Error("What's new views render inside WhatsNewContext")
  }
  return context
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
