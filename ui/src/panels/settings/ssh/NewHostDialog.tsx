import { sshHostInput, type SshStatus } from '@seti/shared'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { CrudEditDialog, Field } from '@/components/crud/CrudForm'
import { Input } from '@/components/ui/input'
import { KeyPicker } from './KeyPicker'
import { JumpSelect } from './SshHostFields'
import { keyChoice, keyChosen, NEW_KEY, resolveKey, type KeyChoice } from './key-choice'
import { checkWhenOpened, openHost } from './ssh-state'

interface NewHostForm {
  alias: string
  hostname: string
  port: string
  user: string
  jump: string | null
}

const EMPTY: NewHostForm = { alias: '', hostname: '', port: '22', user: '', jump: null }

/** Host fields checked before a new key is made, so a bad host name makes no stray key. */
const hostOnly = sshHostInput.omit({ key_id: true })

/** A new host, key first: an existing key, or one generated or pasted here. */
export function NewHostDialog({
  status,
  keyId = null,
  onClose,
}: {
  status: SshStatus
  /** The key to start on, as from a key's page. */
  keyId?: string | null
  onClose: () => void
}) {
  const [form, setForm] = useState<NewHostForm>(EMPTY)
  const [choice, setChoice] = useState<KeyChoice>(() => keyChoice(keyId ?? (status.keys.length === 0 ? NEW_KEY : null)))
  const [saving, setSaving] = useState(false)
  const patch = (next: Partial<NewHostForm>) => {
    setForm((prev) => ({ ...prev, ...next }))
  }
  const create = async () => {
    const parsed = hostOnly.safeParse(form)
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the host')
      return
    }
    setSaving(true)
    try {
      const chosen = await resolveKey(choice)
      setChoice(keyChoice(chosen))
      await apiPost<SshStatus>('/ssh/hosts', { ...parsed.data, key_id: chosen })
      toast.success(`Added ${parsed.data.alias}`)
      checkWhenOpened(parsed.data.alias)
      onClose()
      openHost(parsed.data.alias)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }
  const text = (label: string, key: 'alias' | 'hostname' | 'port' | 'user', placeholder: string) => (
    <Field label={label}>
      <Input
        aria-label={label}
        autoComplete="off"
        className="font-mono"
        placeholder={placeholder}
        value={form[key]}
        onChange={(event) => {
          patch({ [key]: event.target.value })
        }}
      />
    </Field>
  )
  return (
    <CrudEditDialog
      open
      title="New SSH host"
      onCancel={onClose}
      onSave={() => void create()}
      saving={saving}
      canSave={keyChosen(choice)}
      saveLabel="Add"
      savingLabel="Adding..."
      saveIcon={Plus}
    >
      <Field label="SSH key" full>
        <KeyPicker keys={status.keys} choice={choice} onChange={setChoice} />
      </Field>
      {text('Host name', 'hostname', '192.0.2.10')}
      {text('User', 'user', 'ubuntu')}
      {text('Port', 'port', '22')}
      {text('Alias', 'alias', 'k8s')}
      <Field label="Jump host">
        <JumpSelect
          alias={form.alias}
          hosts={status.hosts}
          value={form.jump}
          onChange={(jump) => {
            patch({ jump })
          }}
        />
      </Field>
      <p className="col-span-full text-xs text-muted-foreground">
        One host logs in as one user with one key; agents run ssh &lt;alias&gt;.
      </p>
    </CrudEditDialog>
  )
}
