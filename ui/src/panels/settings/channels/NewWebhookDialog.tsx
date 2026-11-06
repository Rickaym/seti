import { CORE_WEBHOOK_SOURCE, type ChannelCreateInput, type ChannelSecret } from '@seti/shared'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { CrudEditDialog, Field } from '@/components/crud/CrudForm'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useChannelSources } from './sources'

/** Name, sender preset and EA delivery; a sender-issued secret is pasted here. */
export function NewWebhookDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (created: ChannelSecret) => void
}) {
  const [name, setName] = useState('')
  const [preset, setPreset] = useState(CORE_WEBHOOK_SOURCE)
  const [deliver, setDeliver] = useState(false)
  const [secret, setSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const senders = useChannelSources(open)?.webhooks ?? []
  const info = senders.find((sender) => sender.id === preset)

  const reset = () => {
    setName('')
    setPreset(CORE_WEBHOOK_SOURCE)
    setDeliver(false)
    setSecret('')
  }

  const save = async () => {
    setSaving(true)
    try {
      const input: ChannelCreateInput = {
        name,
        preset,
        subscribe_ea: deliver,
        ...(info?.secret === 'sender' ? { secret } : {}),
      }
      onCreated(await apiPost<ChannelSecret>('/channels', input))
      reset()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <CrudEditDialog
      open={open}
      title="New webhook"
      onCancel={() => {
        reset()
        onClose()
      }}
      onSave={() => void save()}
      saving={saving}
      saveLabel="Create"
      savingLabel="Creating..."
      saveIcon={Plus}
    >
      <Field label="Name">
        <Input
          aria-label="Name"
          placeholder="Status page"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
          }}
        />
      </Field>
      <Field label="Source">
        <Select value={preset} onValueChange={setPreset}>
          <SelectTrigger aria-label="Source" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {senders.map((sender) => (
              <SelectItem key={sender.id} value={sender.id}>
                {sender.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <p className="col-span-full text-muted-foreground">{info?.description}</p>
      {info?.secret === 'sender' && (
        <Field label={`${info.label} client secret`} full>
          <Input
            aria-label="Client secret"
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value)
            }}
          />
        </Field>
      )}
      <div className="col-span-full flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">EA delivery</div>
          <div className="text-muted-foreground">Queue events in the EA inbox; off keeps them on this page only.</div>
        </div>
        <Switch aria-label="EA delivery" checked={deliver} onCheckedChange={setDeliver} />
      </div>
    </CrudEditDialog>
  )
}
