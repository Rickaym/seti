import type { McpConnector, McpConnectorList } from '@seti/shared'
import { useEffect, useState } from 'react'
import { apiGet, errorText } from '@/api'

const SEARCH_DELAY_MS = 300

const listPath = (query: string, cursor?: string) => {
  const params = new URLSearchParams({ q: query.trim() })
  if (cursor !== undefined) {
    params.set('cursor', cursor)
  }
  return `/mcp/connectors?${params.toString()}`
}

/** Common connectors and MCP Registry results for a query, with further registry pages on demand. */
export function useConnectors(query: string) {
  const [common, setCommon] = useState<McpConnector[]>([])
  const [registry, setRegistry] = useState<McpConnector[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let stale = false
    const timer = setTimeout(() => {
      setLoading(true)
      apiGet<McpConnectorList>(listPath(query))
        .then((list) => {
          if (!stale) {
            setCommon(list.common)
            setRegistry(list.registry)
            setCursor(list.next_cursor)
            setError(list.registry_error ?? '')
          }
        })
        .catch((e: unknown) => {
          if (!stale) {
            setError(errorText(e))
          }
        })
        .finally(() => {
          if (!stale) {
            setLoading(false)
          }
        })
    }, SEARCH_DELAY_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [query])

  const more = async () => {
    if (cursor === null) {
      return
    }
    setLoading(true)
    try {
      const list = await apiGet<McpConnectorList>(listPath(query, cursor))
      setRegistry((prev) => [...prev, ...list.registry.filter((c) => !prev.some((p) => p.id === c.id))])
      setCursor(list.next_cursor)
      setError(list.registry_error ?? '')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }

  return { common, registry, hasMore: cursor !== null, error, loading, more }
}
