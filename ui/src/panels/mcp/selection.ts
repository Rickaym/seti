import type { McpDefaultInput, McpSelectionEntry } from '@seti/shared'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPut, errorText } from '@/api'

/** Every MCP server Seti knows and whether new agents get it; null while loading. */
export function useMcpSelection() {
  const [entries, setEntries] = useState<McpSelectionEntry[] | null>(null)
  const load = useCallback(() => {
    apiGet<McpSelectionEntry[]>('/mcp/selection')
      .then(setEntries)
      .catch((e: unknown) => {
        setEntries([])
        toast.error(errorText(e))
      })
  }, [])
  useEffect(load, [load])

  const saveDefault = async (name: string, enabled: boolean) => {
    try {
      const body: McpDefaultInput = { enabled }
      setEntries(await apiPut<McpSelectionEntry[]>(`/mcp/defaults/${encodeURIComponent(name)}`, body))
      toast.success(`${name} is ${enabled ? 'on' : 'off'} by default`)
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  return { entries, saveDefault }
}
