import {
  sourcesOf,
  type CommandSource,
  type CommandWorld,
  type CpuCapSettings,
  type ProfileSummary,
  type Task,
  type TaskAccessView,
  type TaskCpuCap,
  type TaskMemoryCap,
  type WorkspaceEntry,
} from '@seti/shared'
import { useEffect, useState } from 'react'
import { apiGet } from '@/api'
import { useCapabilities } from '@/hooks/useCapabilities'
import { useSystem } from '@/hooks/useSystem'

type Loaded = Partial<Pick<CommandWorld, CommandSource>>

/** Reads one source the way the agent's settings read it. */
async function load(task: Task, source: CommandSource): Promise<Loaded> {
  switch (source) {
    case 'access':
      return { access: await apiGet<TaskAccessView>(`/tasks/${task.id}/access`) }
    case 'credentials':
      return { credentials: await apiGet<ProfileSummary[]>('/credential-profiles') }
    case 'workspaces':
      return { workspaces: await apiGet<WorkspaceEntry[]>('/workspaces') }
    case 'memory':
      return { memory: await apiGet<TaskMemoryCap>(`/tasks/${task.id}/memory`) }
    case 'cpu': {
      const [cap, settings] = await Promise.all([
        apiGet<TaskCpuCap>(`/tasks/${task.id}/cpu`),
        apiGet<CpuCapSettings>('/resources/cpu'),
      ])
      return { cpu: { cap, max_percent: settings.max_percent } }
    }
  }
}

/**
 * The agent's state a draft's Seti command is completed and checked against, loading only what
 * its command reads, once per command and agent state rather than per keystroke.
 */
export function useCommandWorld(task: Task, draft: string, active: boolean): CommandWorld {
  const caps = useCapabilities(task)
  const sandboxOn = useSystem().data?.sandbox.enabled ?? false
  const wanted = active ? sourcesOf(draft) : []
  const key = `${task.id}:${task.updated_at}:${wanted.join(',')}`
  const [loaded, setLoaded] = useState<{ key: string; sources: Loaded }>({ key: '', sources: {} })
  useEffect(() => {
    if (wanted.length === 0) {
      return undefined
    }
    let stale = false
    Promise.all(wanted.map(async (source) => load(task, source))).then(
      (parts) => {
        if (!stale) {
          setLoaded({ key, sources: Object.assign({}, ...parts) as Loaded })
        }
      },
      () => undefined,
    )
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key holds every input that matters
  }, [key])
  const sources = loaded.key === key ? loaded.sources : {}
  return {
    author: 'user',
    task,
    caps,
    sandboxOn,
    access: sources.access ?? null,
    credentials: sources.credentials ?? null,
    workspaces: sources.workspaces ?? null,
    memory: sources.memory ?? null,
    cpu: sources.cpu ?? null,
  }
}
