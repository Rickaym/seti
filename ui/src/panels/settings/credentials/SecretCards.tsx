import { SECRET_INFO, secretSetInput, type SecretStatus } from '@seti/shared'
import { Save, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiGet, apiPut, errorText } from '@/api'
import { RelativeTime } from '@/components/RelativeTime'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { Input } from '@/components/ui/input'
import { refreshSystem } from '@/hooks/useSystem'
import { SettingRow, SettingsCard } from '../layout'
import { useMovedCard } from '../use-moved-card'

function StatusText({ status }: { status: SecretStatus }) {
  if (!status.configured || status.updated_at === null) {
    return <>Not set</>
  }
  return (
    <>
      Set <RelativeTime iso={status.updated_at} />
      {status.source === 'import' ? ', imported from an env file' : ''}
    </>
  )
}

function SecretRow({ status, onChange }: { status: SecretStatus; onChange: (next: SecretStatus) => void }) {
  const info = SECRET_INFO[status.name]
  const confirm = useConfirm()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    const parsed = secretSetInput.safeParse({ value })
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the token')
      return
    }
    setBusy(true)
    try {
      onChange(await apiPut<SecretStatus>(`/secrets/${status.name}`, parsed.data))
      setValue('')
      refreshSystem()
      toast.success(`${info.label} saved`)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    const message = `Agents lose the ${info.label} at their next start. It cannot be shown again, only replaced.`
    if (!(await confirm({ message, confirmLabel: 'Clear', variant: 'destructive' }))) {
      return
    }
    setBusy(true)
    try {
      await apiDelete(`/secrets/${status.name}`)
      onChange({ ...status, configured: false, source: null, updated_at: null })
      refreshSystem()
      toast.success(`${info.label} cleared`)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingRow
      label={info.label}
      stack
      description={
        <>
          {info.description} <span className="font-mono">{info.env}</span>.{' '}
          <span className="text-foreground">
            <StatusText status={status} />
          </span>
        </>
      }
    >
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <Input
          type="password"
          aria-label={info.label}
          autoComplete="off"
          className="w-56 font-mono max-md:w-full"
          placeholder={status.configured ? 'Replace' : info.placeholder}
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
          }}
        />
        <Button type="submit" size="sm" disabled={busy || value.trim() === ''}>
          <Save />
          Save
        </Button>
        {status.configured && (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void clear()}>
            <Trash2 />
            Clear
          </Button>
        )}
      </form>
    </SettingRow>
  )
}

/** Seti's own agent tokens, which every agent's proxy uses whatever credential it picks. */
export function AgentTokens() {
  const [statuses, setStatuses] = useState<SecretStatus[] | null>(null)
  const [error, setError] = useState('')
  const load = () => {
    apiGet<SecretStatus[]>('/secrets').then(setStatuses, (e: unknown) => {
      setError(errorText(e))
    })
  }
  useEffect(load, [])
  useMovedCard(statuses !== null)
  if (statuses === null) {
    return (
      <p className={error === '' ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>
        {error === '' ? 'Loading...' : error}
      </p>
    )
  }
  return (
    <SettingsCard id="secrets" title="Agent tokens">
      {statuses.map((status) => (
        <SecretRow key={status.name} status={status} onChange={load} />
      ))}
    </SettingsCard>
  )
}
