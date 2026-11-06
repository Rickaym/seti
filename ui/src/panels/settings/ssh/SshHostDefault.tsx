import type { AccessDefaultInput, SshHost, SshStatus } from '@seti/shared'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPut, errorText } from '@/api'
import { DefaultSwitch } from '@/panels/access/DefaultSwitch'

/** Whether every agent without its own choice reaches this host; new hosts start off. */
export function SshHostDefault({ host, onUpdate }: { host: SshHost; onUpdate: (next: SshStatus) => void }) {
  const [busy, setBusy] = useState(false)
  const save = async (enabled: boolean) => {
    setBusy(true)
    try {
      const body: AccessDefaultInput = { kind: 'ssh', id: host.alias, enabled }
      await apiPut('/access/defaults', body)
      onUpdate(await apiGet<SshStatus>('/ssh'))
      toast.success(`${host.alias} is ${enabled ? 'on' : 'off'} by default`)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <DefaultSwitch
      name={host.alias}
      enabled={host.default_enabled}
      disabled={busy}
      onChange={(enabled) => void save(enabled)}
    />
  )
}
