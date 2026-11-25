import type {
  AccessDefault,
  AccessDefaultInput,
  AccessItem,
  AccessKind,
  McpSessionState,
  TaskAccessView,
} from '@seti/shared'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPut, errorText } from '@/api'
import { useMcpReports } from '@/lib/mcp-reports'

const KIND_WORD: Record<AccessKind, string> = { ssh: 'SSH', aws: 'AWS', mcp: 'MCP', pack: 'Pack', plugin: 'Plugin' }

/** An item named with its kind, as a preview lists it: "SSH db-bastion", "AWS". */
export const accessLabel = (item: { kind: AccessKind; name: string }) =>
  item.kind === 'aws' ? 'AWS' : `${KIND_WORD[item.kind]} ${item.name}`

/** Every item agents may reach with its default, or null while loading. */
export function useAccessCatalog() {
  const [catalog, setCatalog] = useState<AccessDefault[] | null>(null)
  const load = useCallback(() => {
    apiGet<AccessDefault[]>('/access').then(setCatalog, (e: unknown) => {
      setCatalog([])
      toast.error(errorText(e))
    })
  }, [])
  useEffect(load, [load])

  const saveDefault = async (item: Pick<AccessDefault, 'kind' | 'id' | 'name'>, enabled: boolean) => {
    try {
      const body: AccessDefaultInput = { kind: item.kind, id: item.id, enabled }
      setCatalog(await apiPut<AccessDefault[]>('/access/defaults', body))
      toast.success(`${item.name} is ${enabled ? 'on' : 'off'} by default`)
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  return { catalog, saveDefault }
}

const BROKEN: ReadonlySet<McpSessionState['status']> = new Set(['needs-auth', 'failed', 'not_loaded'])

/** An enabled MCP server the agent's latest session could not use. */
export const mcpBroken = (item: AccessItem) => item.session !== null && BROKEN.has(item.session.status)

/** How many access changes each task had in this tab, so every view of its access reloads. */
const changes = new Map<string, number>()
const changeListeners = new Set<() => void>()

function subscribeChanges(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

export function noteAccessChange(taskId: string): void {
  changes.set(taskId, (changes.get(taskId) ?? 0) + 1)
  for (const listener of changeListeners) {
    listener()
  }
}

/**
 * The agent's access, loaded again when its credentials or access change, since logins and AWS
 * come with them, and when its session reports how its MCP servers connect.
 */
export function useTaskAccess(taskId: string, profileId: string | null = null) {
  const [view, setView] = useState<TaskAccessView | null>(null)
  const mcpReports = useMcpReports(taskId)
  const changed = useSyncExternalStore(subscribeChanges, () => changes.get(taskId) ?? 0)
  const load = useCallback(() => {
    apiGet<TaskAccessView>(`/tasks/${taskId}/access`).then(setView, (e: unknown) => {
      toast.error(errorText(e))
    })
  }, [taskId])
  useEffect(load, [load, profileId, mcpReports, changed])
  return { view, setView, load }
}
