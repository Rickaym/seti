import {
  CORE_WEBHOOK_SOURCE,
  type ChannelInfo,
  type WebhookChannelInfo,
  type ChannelRotateInput,
  type ChannelSecret,
  type ChannelUpdateInput,
} from '@seti/shared'
import { Eye, KeyRound, Package, Send, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiPost, apiPut, errorText } from '@/api'
import { CopyButton } from '@/components/CopyButton'
import { Hint } from '@/components/Hint'
import { SettingsLink } from '@/components/SettingsLink'
import { CrudEditDialog, Field } from '@/components/crud/CrudForm'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { Input } from '@/components/ui/input'
import { DESTRUCTIVE_ON_INTENT } from '@/components/ui/table-action-buttons'
import { relativeTime } from '@/lib/time'
import { SettingRow, SettingsCard } from '../layout'
import { Activity } from './Activity'
import { MappingEditor } from './MappingEditor'
import { Subscribers } from './Subscribers'
import { hookUrl } from './hook-url'

/** Asks for the new secret a sender such as Sentry issued. */
function SenderSecretDialog({
  info,
  open,
  onClose,
  onRotate,
}: {
  info: WebhookChannelInfo
  open: boolean
  onClose: () => void
  onRotate: (secret: string) => void
}) {
  const [secret, setSecret] = useState('')
  const label = info.sender.label
  return (
    <CrudEditDialog
      open={open}
      title={`New ${label} secret`}
      onCancel={onClose}
      onSave={() => {
        onRotate(secret)
        setSecret('')
      }}
      saving={false}
      saveLabel="Rotate"
      saveIcon={KeyRound}
    >
      <Field label={`${label} client secret`} full>
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
    </CrudEditDialog>
  )
}

export function WebhookCard({
  info,
  onChange,
  onRemoved,
  onSecret,
}: {
  info: WebhookChannelInfo
  onChange: (next: ChannelInfo) => void
  onRemoved: (id: string) => void
  onSecret: (created: ChannelSecret) => void
}) {
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  const [askSecret, setAskSecret] = useState(false)
  const preset = info.sender
  const url = hookUrl(info)

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    try {
      await work()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const update = (input: ChannelUpdateInput) => {
    void run(async () => {
      onChange(await apiPut<WebhookChannelInfo>(`/channels/${info.id}`, input))
    })
  }
  const rotateWith = (input: ChannelRotateInput) => {
    setAskSecret(false)
    void run(async () => {
      const rotated = await apiPost<ChannelSecret>(`/channels/${info.id}/rotate`, input)
      onChange(rotated.channel)
      onSecret(rotated)
    })
  }
  const rotate = async () => {
    if (preset.secret === 'sender') {
      setAskSecret(true)
      return
    }
    const message = `Rotate the secret of ${info.name}? The sender must switch to the new one; the old one stops working now.`
    if (await confirm({ message, confirmLabel: 'Rotate', variant: 'destructive' })) {
      rotateWith({})
    }
  }
  const remove = async () => {
    const message = `Delete ${info.name}? Its URL stops working, and its events and deliveries go with it.`
    if (await confirm({ message, confirmLabel: 'Delete', variant: 'destructive' })) {
      await run(async () => {
        await apiDelete(`/channels/${info.id}`)
        onRemoved(info.id)
      })
    }
  }
  const reveal = () => {
    void run(async () => {
      const revealed = await apiPost<ChannelSecret>(`/channels/${info.id}/reveal`, {})
      onChange(revealed.channel)
      onSecret(revealed)
    })
  }
  const sendTest = () => {
    void run(async () => {
      onChange(await apiPost<WebhookChannelInfo>(`/channels/${info.id}/test`, {}))
      toast.success('Test event sent')
    })
  }

  return (
    <SettingsCard
      title={info.name}
      actions={
        <div className="flex items-center gap-1">
          <Hint text="Send a signed sample through the same checks as a real delivery">
            <Button size="xs" variant="outline" disabled={busy || info.unavailable !== null} onClick={sendTest}>
              <Send />
              Test
            </Button>
          </Hint>
          <Hint text="Issue a new secret; the old one stops working">
            <Button
              size="xs"
              variant="ghost"
              className="text-muted-foreground"
              disabled={busy}
              onClick={() => void rotate()}
            >
              <KeyRound />
              Rotate
            </Button>
          </Hint>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            className={DESTRUCTIVE_ON_INTENT}
            aria-label={`Delete ${info.name}`}
            onClick={() => void remove()}
          >
            <Trash2 />
          </Button>
        </div>
      }
    >
      <SettingRow
        label="URL"
        stack
        description={`${preset.label}: signed with ${preset.signature}; secret ${info.secret_rotated_at === null ? 'set' : 'rotated'} ${relativeTime(info.secret_rotated_at ?? info.created_at)}`}
      >
        <code className="max-w-md break-all" data-testid="channel-url">
          {url}
        </code>
        <CopyButton text={url} label="URL" />
      </SettingRow>
      {info.unavailable !== null && (
        <SettingRow label="Paused" description={`${info.unavailable}, so this webhook refuses every delivery.`}>
          <SettingsLink page="mods">
            <Package className="mr-1 inline size-3" />
            Mods
          </SettingsLink>
        </SettingRow>
      )}
      {info.secret_pending === 'reveal' && (
        <SettingRow label="New secret" description="The EA had Seti issue it; Seti shows it to you once.">
          <Button size="xs" disabled={busy} onClick={reveal}>
            <Eye />
            Show
          </Button>
        </SettingRow>
      )}
      {info.secret_pending === 'paste' && (
        <SettingRow
          label="Secret missing"
          description={`Paste the client secret ${preset.label} issued; deliveries are refused until then.`}
        >
          <Button
            size="xs"
            disabled={busy}
            onClick={() => {
              setAskSecret(true)
            }}
          >
            <KeyRound />
            Paste
          </Button>
        </SettingRow>
      )}
      <Subscribers info={info} onChange={onChange} />
      {info.preset === CORE_WEBHOOK_SOURCE && (
        <MappingEditor
          info={info}
          busy={busy}
          onSave={(mapping) => {
            update({ mapping })
          }}
        />
      )}
      <Activity info={info} />
      <SenderSecretDialog
        info={info}
        open={askSecret}
        onClose={() => {
          setAskSecret(false)
        }}
        onRotate={(secret) => {
          rotateWith({ secret })
        }}
      />
    </SettingsCard>
  )
}
