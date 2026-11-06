import { KIND_SLOTS, neededSlots, type Connection, type ConnectionSlot, type ConnectionSlotStatus } from '@seti/shared'
import { Save, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiGet, apiPut, errorText } from '@/api'
import { RelativeTime } from '@/components/RelativeTime'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { SettingRow, SettingsCard } from '../layout'
import { ValueInput } from './ValueInput'
import { SLOT_LABEL } from './connection-form'

function SlotRow({
  connection,
  status,
  onChanged,
}: {
  connection: Connection
  status: ConnectionSlotStatus
  onChanged: (next: Connection) => void
}) {
  const confirm = useConfirm()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const label = SLOT_LABEL[status.slot]
  const path = `/connections/${connection.id}/values/${status.slot}`

  const run = async (action: () => Promise<Connection>, done: string) => {
    setBusy(true)
    try {
      onChanged(await action())
      setValue('')
      toast.success(done)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    const message = `Agents and pollers using ${connection.name} lose its ${label.toLowerCase()} at once.`
    if (await confirm({ message, confirmLabel: 'Clear', variant: 'destructive' })) {
      await run(async () => {
        await apiDelete(path)
        return apiGet<Connection>(`/connections/${connection.id}`)
      }, `${label} cleared`)
    }
  }

  return (
    <SettingRow
      label={label}
      stack
      description={
        status.updated_at === null ? (
          'Not set'
        ) : (
          <>
            Set <RelativeTime iso={status.updated_at} />
          </>
        )
      }
    >
      <form
        className="flex items-center gap-2 max-md:flex-wrap"
        onSubmit={(event) => {
          event.preventDefault()
          void run(async () => apiPut<Connection>(path, { value }), `${label} saved`)
        }}
      >
        <ValueInput
          slot={status.slot}
          value={value}
          placeholder={status.set ? 'Replace' : 'Paste'}
          className="w-56 max-md:w-full"
          onChange={setValue}
        />
        <Button type="submit" size="sm" disabled={busy || value.trim() === ''}>
          <Save />
          Save
        </Button>
        {status.set && (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void clear()}>
            <Trash2 />
            Clear
          </Button>
        )}
      </form>
    </SettingRow>
  )
}

const shown = (connection: Connection): ConnectionSlot[] => {
  const needed = new Set(neededSlots(connection.kind, connection.mint))
  return KIND_SLOTS[connection.kind].filter(
    (slot) => needed.has(slot) || connection.slots.some((status) => status.slot === slot && status.set),
  )
}

/** The values a connection holds, set and cleared one at a time and never shown. */
export function ConnectionValues({
  connection,
  onChanged,
}: {
  connection: Connection
  onChanged: (next: Connection) => void
}) {
  const slots = shown(connection)
  return (
    <SettingsCard title="Values">
      {connection.slots
        .filter((status) => slots.includes(status.slot))
        .map((status) => (
          <SlotRow key={status.slot} connection={connection} status={status} onChanged={onChanged} />
        ))}
    </SettingsCard>
  )
}
