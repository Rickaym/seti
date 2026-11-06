import type { RevisionObjectRef, RevisionObjectType, UnseenChange } from '@seti/shared'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, errorText } from '@/api'

const refKey = (type: RevisionObjectType, id: string) => `${type}:${id}`

/** Which objects an agent changed since the user last looked; reloads when `refresh` changes. */
export function useUnseenChanges(refresh: unknown) {
  const [changes, setChanges] = useState<UnseenChange[]>([])
  const [reload, setReload] = useState(0)

  useEffect(() => {
    apiGet<UnseenChange[]>('/revisions/unseen')
      .then(setChanges)
      .catch((e: unknown) => toast.error(errorText(e)))
  }, [refresh, reload])

  const keys = useMemo(() => new Set(changes.map((c) => refKey(c.object_type, c.object_id))), [changes])
  const isUnseen = useCallback((type: RevisionObjectType, id: string) => keys.has(refKey(type, id)), [keys])

  const markSeen = useCallback((ref: RevisionObjectRef) => {
    apiPost('/revisions/seen', ref)
      .then(() => {
        setReload((v) => v + 1)
      })
      .catch((e: unknown) => toast.error(errorText(e)))
  }, [])

  return { isUnseen, markSeen }
}
