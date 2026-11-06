import type { Connection, MintTest } from '@seti/shared'
import { FlaskConical, Save, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiPost, apiPut, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { navigate } from '@/lib/route'
import { SettingsCard } from '../layout'
import { ConnectionFields } from './ConnectionFields'
import { ConnectionValues } from './ConnectionValues'
import { CredentialSwitches } from './CredentialSwitches'
import { checkedSettings, formOf, kindLabel, type ConnectionForm } from './connection-form'
import { useCredentialList } from './use-credential-list'

function SettingsForm({ connection, onChanged }: { connection: Connection; onChanged: (next: Connection) => void }) {
  const [form, setForm] = useState<ConnectionForm>(() => formOf(connection))
  const [busy, setBusy] = useState(false)
  const save = async () => {
    const checked = checkedSettings(form)
    if ('error' in checked) {
      toast.error(checked.error)
      return
    }
    setBusy(true)
    try {
      onChanged(await apiPut<Connection>(`/connections/${connection.id}`, checked.settings))
      toast.success('Saved; agents using it restart at their next turn')
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsCard
      title={kindLabel(connection)}
      actions={
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          <Save />
          Save
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-4 p-3 sm:grid-cols-2">
        <ConnectionFields
          form={form}
          set={(patch) => {
            setForm((prev) => ({ ...prev, ...patch }))
          }}
        />
      </div>
    </SettingsCard>
  )
}

function Carriers({ connection, onChanged }: { connection: Connection; onChanged: (next: Connection) => void }) {
  const credentials = useCredentialList()
  const [busy, setBusy] = useState(false)
  const chosen = new Set(connection.profiles.map((profile) => profile.id))
  const toggle = async (id: string, on: boolean) => {
    const next = new Set(chosen)
    if (on) {
      next.add(id)
    } else {
      next.delete(id)
    }
    setBusy(true)
    try {
      onChanged(await apiPut<Connection>(`/connections/${connection.id}/credentials`, { profile_ids: [...next] }))
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsCard title="Credentials">
      <p className="border-b border-border p-3 text-muted-foreground">
        Agents using a credential switched on here get {connection.env}. The rest never see it.
      </p>
      <CredentialSwitches
        connection={connection.name}
        credentials={credentials}
        chosen={chosen}
        disabled={busy}
        onToggle={(id, on) => void toggle(id, on)}
      />
    </SettingsCard>
  )
}

function TestMint({ connection, onTested }: { connection: Connection; onTested: () => void }) {
  const [busy, setBusy] = useState(false)
  const test = async () => {
    setBusy(true)
    try {
      const result = await apiPost<MintTest>(`/connections/${connection.id}/test`, {})
      if (result.ok) {
        const until =
          result.expires_at === null ? '' : `, valid until ${new Date(result.expires_at).toLocaleTimeString()}`
        toast.success(`Minted a token${until}`)
      } else {
        toast.error(`Minting failed: ${result.error ?? 'unknown reason'}`)
      }
      onTested()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void test()}>
      <FlaskConical />
      Test
    </Button>
  )
}

function DeleteConnection({ connection }: { connection: Connection }) {
  const confirm = useConfirm()
  const remove = async () => {
    const carriers = connection.profiles.map((profile) => profile.name).join(', ')
    const where = carriers === '' ? 'No credential carries it.' : `Agents of ${carriers} lose it at their next turn.`
    const message = `${where} Its values are deleted.`
    const title = `Delete ${connection.name}`
    if (!(await confirm({ title, message, confirmLabel: 'Delete', variant: 'destructive' }))) {
      return
    }
    try {
      await apiDelete(`/connections/${connection.id}`)
      toast.success(`Deleted ${connection.name}`)
      navigate('settings', 'connections', { force: true })
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  return (
    <Button size="sm" variant="outline" onClick={() => void remove()}>
      <Trash2 />
      Delete
    </Button>
  )
}

/** One connection: its settings, values, the credentials that carry it and what sends it. */
export function ConnectionDetail({
  connection,
  onChanged,
  reload,
}: {
  connection: Connection
  onChanged: (next: Connection) => void
  reload: () => void
}) {
  return (
    <div className="space-y-4">
      <SettingsForm key={connection.id} connection={connection} onChanged={onChanged} />
      <ConnectionValues connection={connection} onChanged={onChanged} />
      <Carriers connection={connection} onChanged={onChanged} />
      {connection.pollers.length > 0 && (
        <SettingsCard title="Pollers">
          <p className="p-3 text-muted-foreground">
            {connection.pollers.join(', ')} send its value. Rename or delete it after changing them.
          </p>
        </SettingsCard>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {connection.kind !== 'key' && <TestMint connection={connection} onTested={reload} />}
        <DeleteConnection connection={connection} />
      </div>
    </div>
  )
}
