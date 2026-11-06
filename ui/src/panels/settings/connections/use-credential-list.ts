import type { ProfileSummary } from '@seti/shared'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, errorText } from '@/api'

/** Every credential, the bundles agents pick, loaded once. */
export function useCredentialList(): ProfileSummary[] | null {
  const [list, setList] = useState<ProfileSummary[] | null>(null)
  useEffect(() => {
    apiGet<ProfileSummary[]>('/credential-profiles').then(setList, (e: unknown) => {
      setList([])
      toast.error(errorText(e))
    })
  }, [])
  return list
}
