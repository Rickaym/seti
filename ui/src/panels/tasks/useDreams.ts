import type { DreamRun, DreamSettings, Revision } from '@seti/shared'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut, errorText } from '@/api'

const WHILE_DREAMING_MS = 3000

/** The memory changes a dream recorded: Seti's revisions of the agent's memory while it ran. */
const changesOf = (run: DreamRun, revisions: readonly Revision[]) =>
  revisions.filter(
    (revision) =>
      revision.actor === 'system' &&
      revision.at >= run.started_at &&
      (run.ended_at === null || revision.at <= run.ended_at),
  )

/** The agent's latest dream with its memory changes, Dream now, and undo of one change. */
export function useDreams(taskId: string, open: boolean) {
  const [latest, setLatest] = useState<DreamRun | null>(null)
  const [changes, setChanges] = useState<Revision[]>([])
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!open) {
      return
    }
    let stale = false
    const load = async () => {
      const [run] = await apiGet<DreamRun[]>(`/tasks/${taskId}/dreams`)
      const revisions =
        run === undefined ? [] : await apiGet<Revision[]>(`/revisions?object_type=memory_file&task_id=${taskId}`)
      if (!stale) {
        setLatest(run ?? null)
        setChanges(run === undefined ? [] : changesOf(run, revisions))
      }
    }
    load().catch((e: unknown) => toast.error(errorText(e)))
    const timer =
      latest?.state === 'running' ? setInterval(() => void load().catch(() => undefined), WHILE_DREAMING_MS) : null
    return () => {
      stale = true
      if (timer !== null) {
        clearInterval(timer)
      }
    }
  }, [taskId, open, reload, latest?.state])

  const dreamNow = useCallback(() => {
    apiPost<DreamRun>(`/tasks/${taskId}/dream`, {})
      .then(setLatest)
      .catch((e: unknown) => toast.error(errorText(e)))
  }, [taskId])

  const undo = useCallback((revision: Revision) => {
    apiPost(`/revisions/${String(revision.id)}/revert`, {})
      .then(() => {
        setReload((n) => n + 1)
      })
      .catch((e: unknown) => toast.error(errorText(e)))
  }, [])

  return { latest, changes, dreamNow, undo }
}

/** Whether nightly Dreaming covers the agent: Dreaming's switch, and the agent's own. */
export function useNightly(taskId: string, open: boolean) {
  const [state, setState] = useState<{ enabled: boolean; on: boolean } | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    Promise.all([apiGet<DreamSettings>('/dreams/settings'), apiGet<{ tasks: string[] }>('/dreams/off')]).then(
      ([settings, off]) => {
        setState({ enabled: settings.enabled, on: !off.tasks.includes(taskId) })
      },
      (e: unknown) => toast.error(errorText(e)),
    )
  }, [taskId, open])

  const switchTo = useCallback(
    (on: boolean) => {
      apiPut(`/tasks/${taskId}/dreaming`, { on })
        .then(() => {
          setState((current) => current && { ...current, on })
        })
        .catch((e: unknown) => toast.error(errorText(e)))
    },
    [taskId],
  )

  return { nightly: state, switchTo }
}
