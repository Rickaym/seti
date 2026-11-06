import { useEffect } from 'react'

/**
 * Marks `<html>` while the phone agent view shows, so the status bar steps aside
 * and the chat gets its room; the `agent-room` variant styles that.
 */
export function useAgentRoom(): void {
  useEffect(() => {
    const root = document.documentElement
    root.toggleAttribute('data-agent-room', true)
    return () => {
      root.toggleAttribute('data-agent-room', false)
    }
  }, [])
}
