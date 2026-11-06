import type { NotificationStatus, TestNotificationResult } from '@seti/shared'
import { BellRing, Send, Trash2, Volume2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiPost, errorText } from '@/api'
import { RelativeTime } from '@/components/RelativeTime'
import { ToggleButton } from '@/components/ToggleButton'
import { Button } from '@/components/ui/button'
import { refreshNotifications, useNotifications } from '@/hooks/useNotifications'
import { deviceId } from '@/lib/device'
import { playSound, setSoundOn, soundOn } from '@/lib/notify-sound'
import { disablePush, enablePush, pushBlocker, type PushBlocker } from '@/lib/push'
import { InstallHint } from './InstallHint'
import { TiersCard } from './TiersCard'
import { SettingRow, SettingsBody, SettingsCard, SettingsHeader } from './layout'

const BLOCKED: Record<PushBlocker, string> = {
  unsupported: 'This browser cannot take push notifications.',
  'ios-browser': 'On iPhone and iPad, only Seti on the Home Screen gets push.',
  denied: "Notifications are blocked for Seti here. Allow them in the browser's site settings, then reload.",
}

function pushDescription(status: NotificationStatus | undefined, subscribed: boolean): string {
  const blocker = pushBlocker()
  if (blocker !== null) {
    return BLOCKED[blocker]
  }
  if (status?.public_key === null) {
    return 'Seti cannot send push notifications without its secret key.'
  }
  return subscribed
    ? 'On: this device hears about agents while Seti is closed or in the background.'
    : 'Off: turn it on to hear about agents while Seti is closed or in the background.'
}

function PushRow({ status, subscribed }: { status: NotificationStatus | undefined; subscribed: boolean }) {
  const [busy, setBusy] = useState(false)
  const key = status?.public_key ?? null
  const toggle = async (on: boolean) => {
    setBusy(true)
    try {
      if (on && key !== null) {
        await enablePush(key)
        toast.success('Push on for this device')
      } else {
        await disablePush()
        toast.success('Push off for this device')
      }
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
      refreshNotifications()
    }
  }
  const test = async () => {
    setBusy(true)
    try {
      const result = await apiPost<TestNotificationResult>('/notifications/test', { device_id: deviceId() })
      if (result.sent > 0) {
        toast.success('Test sent')
      } else {
        toast.error('The push service refused the test; turn push off and on again')
      }
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
      refreshNotifications()
    }
  }
  return (
    <SettingRow label="Push notifications" stack description={pushDescription(status, subscribed)}>
      <ToggleButton
        pressed={subscribed}
        disabled={busy || pushBlocker() !== null || key === null}
        onPressedChange={(on) => void toggle(on)}
        icon={BellRing}
        label="Push"
        hint={subscribed ? 'Stop push notifications on this device' : 'Get push notifications on this device'}
      />
      <Button variant="outline" size="sm" disabled={busy || !subscribed} onClick={() => void test()}>
        <Send />
        Test push
      </Button>
    </SettingRow>
  )
}

function SoundRow() {
  const [on, setOn] = useState(soundOn)
  return (
    <SettingRow
      label="Sound"
      description="A short chime while Seti is open: one for a finished turn, another for an agent that needs you. Kept per browser."
    >
      <ToggleButton
        pressed={on}
        onPressedChange={(next) => {
          setSoundOn(next)
          setOn(next)
          if (next) {
            playSound('finished')
          }
        }}
        icon={Volume2}
        label="Sound"
        hint={on ? 'Stay quiet' : 'Play a chime'}
      />
    </SettingRow>
  )
}

function PushDevicesCard({ status }: { status: NotificationStatus }) {
  const own = deviceId()
  const remove = async (id: string) => {
    try {
      await (id === own ? disablePush() : apiDelete(`/notifications/devices/${id}`))
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      refreshNotifications()
    }
  }
  return (
    <SettingsCard title="Push devices">
      {status.devices.length === 0 && <p className="p-3 text-muted-foreground">No device gets push yet.</p>}
      {status.devices.map((device) => (
        <SettingRow
          key={device.device_id}
          label={device.device_id === own ? `${device.label} (this device)` : device.label}
          description={
            <>
              Push on since <RelativeTime iso={device.created_at} />
            </>
          }
        >
          <Button
            variant="outline"
            size="sm"
            aria-label={`Remove ${device.label}`}
            onClick={() => void remove(device.device_id)}
          >
            <Trash2 />
            Remove
          </Button>
        </SettingRow>
      ))}
    </SettingsCard>
  )
}

export function NotificationsPage() {
  const { status, settings, subscribed } = useNotifications()
  return (
    <SettingsBody
      narrow
      header={
        <SettingsHeader
          title="Notifications"
          description="Hear what needs you, without watching the page, and a brief when you come back."
        />
      }
    >
      <div className="space-y-4">
        {pushBlocker() === 'ios-browser' && <InstallHint />}
        <SettingsCard title="This device">
          <PushRow status={status} subscribed={subscribed} />
          <SoundRow />
        </SettingsCard>
        <TiersCard settings={settings} />
        {status !== undefined && <PushDevicesCard status={status} />}
      </div>
    </SettingsBody>
  )
}
