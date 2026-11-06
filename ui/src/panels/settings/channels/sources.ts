import type { ChannelSources } from '@seti/shared'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, errorText } from '@/api'

/**
 * The sources a new channel can come from, read each time a form opens, as mods turn on and off.
 * `onLoad` sees them once read; keep it stable across renders.
 */
export function useChannelSources(open: boolean, onLoad?: (sources: ChannelSources) => void): ChannelSources | null {
  const [sources, setSources] = useState<ChannelSources | null>(null)
  useEffect(() => {
    if (!open) {
      return
    }
    let current = true
    apiGet<ChannelSources>('/channels/sources')
      .then((loaded) => {
        if (current) {
          setSources(loaded)
          onLoad?.(loaded)
        }
      })
      .catch((e: unknown) => {
        toast.error(errorText(e))
      })
    return () => {
      current = false
    }
  }, [open, onLoad])
  return sources
}
