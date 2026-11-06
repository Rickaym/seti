import type { ContextPack, ContextPackLinks } from '@seti/shared'
import { useEffect, useState } from 'react'
import { apiGet } from '@/api'

const SHOWN = 6

function readers(links: ContextPackLinks): string {
  const agents = links.agents.map((agent) => agent.title)
  const shown = [...(links.ea ? ['EA'] : []), ...agents.slice(0, SHOWN)]
  const more = agents.length - SHOWN
  return more > 0 ? `${shown.join(', ')} and ${String(more)} more` : shown.join(', ')
}

/** Who reads a saved pack now: the EA when it is linked, and agents linked by choice or default. */
export function PackLinks({ pack }: { pack: Pick<ContextPack, 'id' | 'linked_by_default'> | null }) {
  const [links, setLinks] = useState<ContextPackLinks | null>(null)
  const id = pack?.id ?? null
  const byDefault = pack?.linked_by_default ?? false
  useEffect(() => {
    if (id === null) {
      return
    }
    apiGet<ContextPackLinks>(`/context/packs/${id}/links`).then(setLinks, () => {
      setLinks(null)
    })
  }, [id, byDefault])
  if (id === null || links === null) {
    return null
  }
  const text = readers(links)
  return (
    <p aria-label="Linked to" className="shrink-0 truncate text-2xs text-muted-foreground">
      {text === '' ? 'Linked to no agent and not to the EA' : `Linked to ${text}`}
    </p>
  )
}
