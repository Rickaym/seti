import {
  CUSTOM_WEBHOOK_SOURCE,
  normalizeEventKind,
  type ChannelCreateInput,
  type ChannelSecret,
  type WebhookSourceInfo,
} from '@seti/shared'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { CrudEditDialog, Field } from '@/components/crud/CrudForm'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { SampleTester } from './SampleTester'
import { SenderFields } from './SenderFields'
import { SenderPicker } from './SenderPicker'
import { EMPTY_SENDER, senderOfForm, type SenderForm } from './sender-form'
import { useChannelSources } from './sources'

const kindsOf = (text: string) => [...new Set(text.split(',').map(normalizeEventKind))].filter((kind) => kind !== '')

/** The event kinds the EA's inbox takes, typed or toggled from the kinds the app reports. */
function EventKinds({
  kinds,
  value,
  onChange,
}: {
  kinds: readonly string[]
  value: string
  onChange: (v: string) => void
}) {
  const chosen = kindsOf(value)
  const toggle = (kind: string) => {
    onChange((chosen.includes(kind) ? chosen.filter((entry) => entry !== kind) : [...chosen, kind]).join(', '))
  }
  return (
    <Field label="Events" full>
      <Input
        aria-label="Events"
        placeholder="All events"
        autoCapitalize="off"
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
        }}
      />
      {kinds.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={chosen.includes(kind)}
              onClick={() => {
                toggle(kind)
              }}
              className={cn(
                'border border-border px-1.5 py-0.5 font-mono text-2xs hover:bg-muted pointer-coarse:min-h-8',
                chosen.includes(kind) && 'border-primary bg-primary/10 text-primary',
              )}
            >
              {kind}
            </button>
          ))}
        </div>
      )}
    </Field>
  )
}

/** The picked app, or the custom sender the user describes. */
type Picked = { custom: false; sender: WebhookSourceInfo } | { custom: true }

interface Draft {
  name: string
  deliver: boolean
  events: string
  secret: string
  form: SenderForm
}

const EMPTY: Draft = { name: '', deliver: false, events: '', secret: '', form: EMPTY_SENDER }

function inputOf(picked: Picked, draft: Draft): ChannelCreateInput {
  const secret = draft.secret.trim()
  const pasted = (picked.custom ? draft.form.appSecret : picked.sender.secret === 'sender') && secret !== ''
  return {
    name: draft.name,
    preset: picked.custom ? CUSTOM_WEBHOOK_SOURCE : picked.sender.id,
    subscribe_ea: draft.deliver,
    ...(draft.deliver ? { ea_events: kindsOf(draft.events) } : {}),
    ...(pasted ? { secret } : {}),
    ...(picked.custom ? { sender: senderOfForm(draft.form) } : {}),
  }
}

function SecretField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label} full>
      <Input
        aria-label={label}
        type="password"
        autoComplete="off"
        placeholder="Paste it now, or after the app shows it"
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
        }}
      />
    </Field>
  )
}

function CustomParts({ draft, change }: { draft: Draft; change: (next: Partial<Draft>) => void }) {
  const secret = draft.secret.trim()
  return (
    <>
      <SenderFields
        form={draft.form}
        set={(next) => {
          change({ form: { ...draft.form, ...next } })
        }}
      />
      {draft.form.appSecret && secret !== '' ? (
        <SampleTester target={() => ({ definition: senderOfForm(draft.form), secret })} />
      ) : (
        <p className="col-span-full text-muted-foreground">
          To check a captured request before creating, paste the app&apos;s secret above. Afterwards, Sample on the
          webhook&apos;s card does the same with the stored secret.
        </p>
      )}
    </>
  )
}

/** The short form after the picker: a name, the app's secret when it issues one, and EA delivery. */
function WebhookForm({
  picked,
  onBack,
  onCreated,
}: {
  picked: Picked
  onBack: () => void
  onCreated: (created: ChannelSecret) => void
}) {
  const [draft, setDraft] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const change = (next: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...next }))
  }
  const label = picked.custom ? 'Custom' : picked.sender.label
  const issued = picked.custom ? draft.form.appSecret : picked.sender.secret === 'sender'
  const save = async () => {
    setSaving(true)
    try {
      onCreated(await apiPost<ChannelSecret>('/channels', inputOf(picked, draft)))
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <CrudEditDialog
      open
      title={`New ${label} webhook`}
      onCancel={onBack}
      onSave={() => void save()}
      saving={saving}
      canSave={draft.name.trim() !== ''}
      saveLabel="Create"
      savingLabel="Creating..."
      saveIcon={Plus}
    >
      <Field label="Name" full>
        <Input
          aria-label="Name"
          placeholder={picked.custom ? 'Status page' : `${label} events`}
          value={draft.name}
          onChange={(e) => {
            change({ name: e.target.value })
          }}
        />
      </Field>
      <p className="col-span-full text-muted-foreground">
        {picked.custom
          ? 'Describe how the app signs its requests and where its fields are.'
          : picked.sender.description}{' '}
        The next step shows the URL to paste into the app.
      </p>
      {issued && (
        <SecretField
          label={picked.custom ? 'Secret' : picked.sender.secret_label}
          value={draft.secret}
          onChange={(secret) => {
            change({ secret })
          }}
        />
      )}
      {picked.custom && <CustomParts draft={draft} change={change} />}
      <div className="col-span-full flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">EA delivery</div>
          <div className="text-muted-foreground">Queue events in the EA inbox; off keeps them on this page only.</div>
        </div>
        <Switch
          aria-label="EA delivery"
          checked={draft.deliver}
          onCheckedChange={(deliver) => {
            change({ deliver })
          }}
        />
      </div>
      {draft.deliver && (
        <EventKinds
          kinds={picked.custom ? [] : picked.sender.kinds}
          value={draft.events}
          onChange={(events) => {
            change({ events })
          }}
        />
      )}
    </CrudEditDialog>
  )
}

/** A searchable picker of the app that sends, then a short form for the webhook it gets. */
export function NewWebhookDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (created: ChannelSecret) => void
}) {
  const [picked, setPicked] = useState<Picked | null>(null)
  const senders = useChannelSources(open)?.webhooks ?? []
  if (!open) {
    return null
  }
  if (picked === null) {
    return (
      <SenderPicker
        senders={senders}
        onClose={onClose}
        onPick={(sender) => {
          setPicked({ custom: false, sender })
        }}
        onCustom={() => {
          setPicked({ custom: true })
        }}
      />
    )
  }
  return (
    <WebhookForm
      picked={picked}
      onBack={() => {
        setPicked(null)
      }}
      onCreated={(created) => {
        setPicked(null)
        onCreated(created)
      }}
    />
  )
}
