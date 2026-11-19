import type { ChannelSecret, WebhookChannelInfo } from '@seti/shared'
import { Check, KeyRound } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { CopyButton } from '@/components/CopyButton'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { hookUrl } from './hook-url'

/** How to point the app at the webhook: its numbered steps, or one paragraph. */
function Setup({ channel }: { channel: WebhookChannelInfo }) {
  const { steps, setup } = channel.sender
  if (steps.length === 0) {
    return <p>{setup}</p>
  }
  return (
    <ol aria-label="Setup steps" className="list-decimal space-y-1 pl-5">
      {steps.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  )
}

/** Takes the secret the app issued once it shows one, which may be after it has the URL. */
function PasteSecret({ channel, onPasted }: { channel: WebhookChannelInfo; onPasted: (next: ChannelSecret) => void }) {
  const [secret, setSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const label = channel.sender.secret_label
  const save = async () => {
    setSaving(true)
    try {
      onPasted(await apiPost<ChannelSecret>(`/channels/${channel.id}/rotate`, { secret: secret.trim() }))
      toast.success('Secret saved')
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div>
      <div className="font-medium">{label}</div>
      <div className="flex items-center gap-1">
        <Input
          aria-label={label}
          type="password"
          autoComplete="off"
          className="min-w-0 flex-1"
          value={secret}
          onChange={(e) => {
            setSecret(e.target.value)
          }}
        />
        <Button size="sm" disabled={saving || secret.trim() === ''} onClick={() => void save()}>
          <KeyRound />
          Save
        </Button>
      </div>
      <p className="mt-1 text-muted-foreground">
        {channel.sender.label} issues it. Deliveries are refused until it is saved; Paste on the card takes it later.
      </p>
    </div>
  )
}

function SecretPart({ created, onPasted }: { created: ChannelSecret; onPasted: (next: ChannelSecret) => void }) {
  if (created.channel.secret_pending === 'paste') {
    return <PasteSecret channel={created.channel} onPasted={onPasted} />
  }
  if (created.secret === null) {
    return (
      <p className="text-muted-foreground">
        {created.channel.sender.label} issued the secret, so Seti does not show it.
      </p>
    )
  }
  return (
    <div>
      <div className="font-medium">Secret</div>
      <div className="flex items-center gap-1">
        <code className="min-w-0 flex-1 break-all" data-testid="webhook-secret">
          {created.secret}
        </code>
        <CopyButton text={created.secret} label="Secret" />
      </div>
      <p className="mt-1 text-warning-text">Copy it now: Seti shows it only this once.</p>
    </div>
  )
}

/** A new or rotated webhook: its URL, the setup steps, and its secret once or a field for it. */
export function SecretDialog({
  created,
  onClose,
  onPasted,
}: {
  created: ChannelSecret | null
  onClose: () => void
  onPasted: (next: ChannelSecret) => void
}) {
  return (
    <Dialog
      open={created !== null}
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      {created !== null && (
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{created.channel.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <div className="font-medium">URL</div>
              <div className="flex items-center gap-1">
                <code className="min-w-0 flex-1 break-all" data-testid="webhook-url">
                  {hookUrl(created.channel)}
                </code>
                <CopyButton text={hookUrl(created.channel)} label="URL" />
              </div>
            </div>
            <Setup channel={created.channel} />
            <SecretPart created={created} onPasted={onPasted} />
          </div>
          <DialogFooter>
            <Button onClick={onClose}>
              <Check />
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}
