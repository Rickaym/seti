import type { Connection, ConnectionCreateInput, ConnectionSlot } from '@seti/shared'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { CrudEditDialog, Field } from '@/components/crud/CrudForm'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { ConnectionFields } from './ConnectionFields'
import { CredentialSwitches } from './CredentialSwitches'
import { ValueInput } from './ValueInput'
import { checkedSettings, neededFor, PRESETS, presetForm, SLOT_LABEL, type ConnectionForm } from './connection-form'
import { useCredentialList } from './use-credential-list'

const FIRST = PRESETS[0] ?? { label: 'API key', hint: '', form: {} }

/** A new connection in one step: what it is, its values and the credentials that carry it. */
export function NewConnectionDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [preset, setPreset] = useState(FIRST)
  const [form, setForm] = useState<ConnectionForm>(() => presetForm(FIRST))
  const [values, setValues] = useState<Partial<Record<ConnectionSlot, string>>>({})
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const credentials = useCredentialList()

  const save = async () => {
    const checked = checkedSettings(form)
    if ('error' in checked) {
      toast.error(checked.error)
      return
    }
    const filled = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim() !== ''))
    const body: ConnectionCreateInput = { ...checked.settings, values: filled, profile_ids: [...chosen] }
    setSaving(true)
    try {
      const created = await apiPost<Connection>('/connections', body)
      toast.success(`Added ${created.name}`)
      onCreated(created.id)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <CrudEditDialog
      open
      title="New connection"
      onCancel={onClose}
      onSave={() => void save()}
      saving={saving}
      canSave={form.name.trim() !== ''}
      saveLabel="Add"
      savingLabel="Adding..."
      saveIcon={Plus}
    >
      <Field label="Kind" full>
        <NativeSelect
          aria-label="Kind"
          className="w-full"
          value={preset.label}
          onChange={(event) => {
            const next = PRESETS.find((entry) => entry.label === event.target.value) ?? FIRST
            setPreset(next)
            setForm({ ...presetForm(next), name: form.name, env: form.env, envEdited: form.envEdited })
            setValues({})
          }}
        >
          {PRESETS.map((entry) => (
            <NativeSelectOption key={entry.label} value={entry.label}>
              {entry.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <span className="text-xs text-muted-foreground">{preset.hint}</span>
      </Field>
      <ConnectionFields
        form={form}
        set={(patch) => {
          setForm((prev) => ({ ...prev, ...patch }))
        }}
      />
      {neededFor(form).map((slot) => (
        <Field key={slot} label={SLOT_LABEL[slot]} full>
          <ValueInput
            slot={slot}
            value={values[slot] ?? ''}
            placeholder="Paste it now or later"
            onChange={(value) => {
              setValues((prev) => ({ ...prev, [slot]: value }))
            }}
          />
        </Field>
      ))}
      <Field label="Credentials" full>
        <div className="border border-border">
          <CredentialSwitches
            connection={form.name.trim() === '' ? 'connection' : form.name.trim()}
            credentials={credentials}
            chosen={chosen}
            onToggle={(id, on) => {
              setChosen((prev) => {
                const next = new Set(prev)
                if (on) {
                  next.add(id)
                } else {
                  next.delete(id)
                }
                return next
              })
            }}
          />
        </div>
      </Field>
      <p className="col-span-full text-2xs text-muted-foreground">
        Values go to Seti and never come back. Agents of the credentials switched on see the variable with a
        placeholder; the proxy puts the value only on these hosts.
      </p>
    </CrudEditDialog>
  )
}
