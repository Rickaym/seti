import { listedStatus, failed, type TaskListEntry } from '@seti/shared'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { useAttention } from '@/hooks/useAttention'
import { useTasks } from '@/hooks/useTasks'
import { classifyFailure, INTERRUPTED } from '@/lib/failure'
import {
  COLLAPSE_ABOVE,
  dismissedFailures,
  dismissFailures,
  failureId,
  failuresSince,
  pendingFailures,
  subscribeDismissed,
} from '@/lib/failure-toasts'
import { navigate } from '@/lib/route'

const SUMMARY = 'failure:summary'
const LISTED = 3

const causeOf = (task: TaskListEntry) =>
  (task.status === 'interrupted' ? INTERRUPTED : classifyFailure(task.last_error ?? '')).title

function summaryText(tasks: readonly TaskListEntry[]): string {
  const titles = tasks.slice(0, LISTED).map((task) => task.title)
  const more = tasks.length - titles.length
  return more > 0 ? `${titles.join(', ')} and ${String(more)} more` : titles.join(', ')
}

/**
 * Toasts that stay until dismissed for agents that failed off screen; several collapse to one.
 * Needs-you always reaches the user, so no setting turns them off; an agent the EA reports on
 * gets the EA's toast instead.
 */
export function FailureToasts({ openId }: { openId: string | null }) {
  const { tasks } = useTasks()
  const { eaTasks } = useAttention()
  const [since] = useState(() => failuresSince())
  const dismissed = useSyncExternalStore(subscribeDismissed, dismissedFailures)
  const pending = useMemo(
    () => pendingFailures(tasks, { since, dismissed, openId }).filter((task) => !eaTasks.has(task.id)),
    [tasks, since, dismissed, openId, eaTasks],
  )
  const shown = useRef(new Set<string>())
  const closing = useRef(new Set<string>())

  const open = tasks.find((task) => task.id === openId)
  const openFailure = open !== undefined && failed(listedStatus(open)) ? failureId(open) : null
  useEffect(() => {
    if (openFailure !== null) {
      dismissFailures([openFailure])
    }
  }, [openFailure])

  useEffect(() => {
    const wanted = new Map<string, () => void>()
    if (pending.length > COLLAPSE_ABOVE) {
      const ids = pending.map(failureId)
      wanted.set(SUMMARY, () => {
        toast.error(`${String(pending.length)} agents failed`, {
          id: SUMMARY,
          duration: Number.POSITIVE_INFINITY,
          description: summaryText(pending),
          action: {
            label: 'Open list',
            onClick: () => {
              dismissFailures(ids)
              navigate('agents')
            },
          },
          cancel: {
            label: 'Dismiss',
            onClick: () => {
              dismissFailures(ids)
            },
          },
          onDismiss: () => {
            if (!closing.current.delete(SUMMARY)) {
              dismissFailures(ids)
            }
          },
        })
      })
    } else {
      for (const task of pending) {
        const id = `failure:${failureId(task)}`
        wanted.set(id, () => {
          toast.error(task.title, {
            id,
            duration: Number.POSITIVE_INFINITY,
            description: causeOf(task),
            action: {
              label: 'Open',
              onClick: () => {
                navigate('agents', task.id)
              },
            },
            cancel: {
              label: 'Dismiss',
              onClick: () => {
                dismissFailures([failureId(task)])
              },
            },
            onDismiss: () => {
              if (!closing.current.delete(id)) {
                dismissFailures([failureId(task)])
              }
            },
          })
        })
      }
    }
    for (const id of shown.current) {
      if (!wanted.has(id)) {
        closing.current.add(id)
        toast.dismiss(id)
      }
    }
    for (const show of wanted.values()) {
      show()
    }
    shown.current = new Set(wanted.keys())
  }, [pending])

  return null
}
