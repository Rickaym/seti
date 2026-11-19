import { CUSTOM_WEBHOOK_SOURCE, isDataSender, type ChannelInfo, type WebhookChannelInfo } from '@seti/shared'
import { Check, FlaskConical, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { CrudEditDialog } from '@/components/crud/CrudForm'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SettingRow } from '../layout'
import { SampleTester } from './SampleTester'
import { SenderFields } from './SenderFields'
import { EMPTY_SENDER, formOfSender, senderOfForm } from './sender-form'

function SampleDialog({ info, onClose }: { info: WebhookChannelInfo; onClose: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent className="flex max-h-[92vh] min-h-0 flex-col gap-0 overflow-hidden border p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle>Sample for {info.name}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="grid grid-cols-1 gap-4">
            <p className="text-muted-foreground">
              Paste a request the app sent, from its delivery log. Seti checks it with this webhook&apos;s stored secret
              and shows the update it would make.
            </p>
            <SampleTester target={() => ({ channel_id: info.id })} />
          </div>
        </div>
        <DialogFooter className="border-t border-border px-4 py-3">
          <Button onClick={onClose}>
            <Check />
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditDialog({
  info,
  onClose,
  onChange,
}: {
  info: WebhookChannelInfo
  onClose: () => void
  onChange: (next: ChannelInfo) => void
}) {
  const stored = info.sender_definition
  const [form, setForm] = useState(stored === null ? EMPTY_SENDER : formOfSender(stored))
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      onChange(await apiPut<WebhookChannelInfo>(`/channels/${info.id}`, { sender: senderOfForm(form) }))
      onClose()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <CrudEditDialog open title={`Sender of ${info.name}`} onCancel={onClose} onSave={() => void save()} saving={saving}>
      <SenderFields
        form={form}
        set={(next) => {
          setForm((current) => ({ ...current, ...next }))
        }}
      />
    </CrudEditDialog>
  )
}

/** For a sender described as data: check a captured request, and edit a custom sender's rules. */
export function SenderRow({ info, onChange }: { info: WebhookChannelInfo; onChange: (next: ChannelInfo) => void }) {
  const [open, setOpen] = useState<'sample' | 'edit' | null>(null)
  if (!isDataSender(info.preset)) {
    return null
  }
  const close = () => {
    setOpen(null)
  }
  return (
    <SettingRow label="Sender" description="Check a request the app sent against this webhook's sender and secret.">
      <div className="flex items-center gap-1">
        <Hint text="Paste a captured request to see whether it verifies and what update it makes">
          <Button
            size="xs"
            variant="outline"
            disabled={info.secret_pending === 'paste'}
            onClick={() => {
              setOpen('sample')
            }}
          >
            <FlaskConical />
            Sample
          </Button>
        </Hint>
        {info.preset === CUSTOM_WEBHOOK_SOURCE && (
          <Hint text="Change how this sender signs and where its fields are">
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setOpen('edit')
              }}
            >
              <SlidersHorizontal />
              Edit
            </Button>
          </Hint>
        )}
      </div>
      {open === 'sample' && <SampleDialog info={info} onClose={close} />}
      {open === 'edit' && <EditDialog info={info} onClose={close} onChange={onChange} />}
    </SettingRow>
  )
}
