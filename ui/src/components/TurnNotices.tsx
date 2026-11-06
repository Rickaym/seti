import { NO_CLOSING_LINE } from '@seti/shared'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAttention } from '@/hooks/useAttention'
import { useNarrow } from '@/hooks/useMedia'
import { useFocusReport, useNotifications } from '@/hooks/useNotifications'
import { useTasks } from '@/hooks/useTasks'
import { failuresSince } from '@/lib/failure-toasts'
import { playSound, soundOn } from '@/lib/notify-sound'
import { navigate, type Route } from '@/lib/route'
import { turnEvents, wantedEvents, type Seen } from '@/lib/turn-events'
import { useActiveLayout, useLayoutAgents } from '@/panels/tasks/agents-layouts'

/** The agents this page shows now: the open one, and the active layout's. */
function useShownAgents(route: Route): string[] {
  const panels = useLayoutAgents(useActiveLayout(useNarrow()))
  if (route.section !== 'agents') {
    return []
  }
  const shown = route.id === null ? panels : [route.id, ...panels]
  return [...new Set(shown)].toSorted((a, b) => a.localeCompare(b))
}

/**
 * Whether the page came back after being hidden for the away time, once: what changed since is
 * the brief's to tell, or another device already showed it, so the next list sets a new baseline.
 */
function useReturned(awayMs: number): () => boolean {
  const returned = useRef(false)
  useEffect(() => {
    let hiddenAt: number | null = document.visibilityState === 'hidden' ? Date.now() : null
    const changed = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt ??= Date.now()
        return
      }
      if (hiddenAt !== null && Date.now() - hiddenAt >= awayMs) {
        returned.current = true
      }
      hiddenAt = null
    }
    document.addEventListener('visibilitychange', changed)
    return () => {
      document.removeEventListener('visibilitychange', changed)
    }
  }, [awayMs])
  return useCallback(() => {
    const was = returned.current
    returned.current = false
    return was
  }, [])
}

/**
 * Raises a toast with the closing line of each agent that finished a turn off screen, and plays
 * a short sound for those and for agents that need you, whose toasts FailureToasts shows. Agents
 * the EA reports on are left to its inbox, so each event surfaces once.
 */
export function TurnNotices({ route }: { route: Route }) {
  const { tasks, loaded } = useTasks()
  const { settings, subscribed } = useNotifications()
  const { eaTasks, awayMs } = useAttention()
  const shownList = useShownAgents(route)
  useFocusReport(shownList)
  const shownKey = shownList.join(' ')
  const shown = useMemo(() => new Set(shownKey === '' ? [] : shownKey.split(' ')), [shownKey])
  const [since] = useState(() => failuresSince())
  const seen = useRef<Seen | null>(null)
  const tookReturn = useReturned(awayMs)

  useEffect(() => {
    if (!loaded) {
      return
    }
    if (tookReturn()) {
      seen.current = null
    }
    const { events, seen: next } = turnEvents(seen.current, tasks, since)
    seen.current = next
    const wanted = wantedEvents(events, settings, shown, eaTasks)
    for (const { task, kind } of wanted) {
      if (kind === 'finished') {
        toast(task.title, {
          id: `finished:${task.id}`,
          description: task.closing_line ?? NO_CLOSING_LINE,
          action: {
            label: 'Open',
            onClick: () => {
              navigate('agents', task.id)
            },
          },
        })
      }
    }
    const loudest = wanted.some((event) => event.kind === 'needs_you') ? 'needs_you' : wanted[0]?.kind
    if (loudest !== undefined && soundOn() && (document.hasFocus() || !subscribed)) {
      playSound(loudest)
    }
  }, [tasks, loaded, since, settings, shown, subscribed, eaTasks, tookReturn])

  return null
}
