import { useEffect, type ReactNode } from 'react'
import { startFindShortcut } from '@/components/shortcuts/find'
import { startGuideShortcut } from '@/components/shortcuts/guide-store'
import { startLanding } from '@/components/shortcuts/landing'

/** Ctrl+F in chats, the guide chord and focus landing after keyboard navigation. */
export function ShortcutProvider({ children }: { children: ReactNode }) {
  useEffect(() => startFindShortcut(), [])
  useEffect(() => startGuideShortcut(), [])
  useEffect(() => startLanding(), [])
  return <>{children}</>
}
