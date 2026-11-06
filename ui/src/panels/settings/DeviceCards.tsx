import { DEVICE_NAME_MAX, type AndroidAppSettings, type DeviceInfo, type PairingCode } from '@seti/shared'
import { Pencil, RefreshCw, Save, Smartphone, Tag, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { renderSVG } from 'uqr'
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, errorText } from '@/api'
import { CopyButton } from '@/components/CopyButton'
import { RelativeTime } from '@/components/RelativeTime'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useBusy } from '@/hooks/useBusy'
import { useNow } from '@/hooks/useNow'
import { startPolling } from '@/lib/poll-loop'
import { AndroidCard } from './AndroidCard'
import { SettingsCard } from './layout'
import { useMovedCard } from './use-moved-card'

const ROW = 'flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0 max-md:flex-wrap'
const PAIR_POLL_MS = 2000

const qrImage = (url: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(url, { border: 2, pixelSize: 8 }))}`

function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`
}

/** Shows a one-time code as a QR code and text, and closes once a new device pairs with it. */
function PairDialog({ known, onPaired, onClose }: { known: string[]; onPaired: () => void; onClose: () => void }) {
  const [pairing, setPairing] = useState<PairingCode | null>(null)
  const [error, setError] = useState('')
  const now = useNow(true, 1000)
  const start = useCallback(() => {
    apiPost<PairingCode>('/devices/pairing', {}).then(
      (made) => {
        setError('')
        setPairing(made)
      },
      (e: unknown) => {
        setError(errorText(e))
      },
    )
  }, [])
  useEffect(start, [start])

  useEffect(() => {
    const check = () => {
      apiGet<DeviceInfo[]>('/devices').then(
        (devices) => {
          const paired = devices.find((device) => !known.includes(device.id))
          if (paired !== undefined) {
            toast.success(`Paired ${paired.name}`)
            onPaired()
          }
        },
        () => undefined,
      )
    }
    // The code may be scanned by an app on this same phone, which hides this page meanwhile.
    return startPolling(check, PAIR_POLL_MS, { whileHidden: true })
  }, [known, onPaired])

  const left = pairing === null ? 0 : Date.parse(pairing.expires_at) - now
  const image = useMemo(() => (pairing === null ? null : qrImage(pairing.url)), [pairing])
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Pair phone</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            In the Seti app, tap Scan QR code and scan this. On the phone itself, copy the link and paste it into the
            app.
          </p>
          {error !== '' && <p className="text-destructive">{error}</p>}
          {pairing !== null && image !== null && left > 0 && (
            <>
              <img src={image} alt="Pairing QR code" className="mx-auto size-56" />
              <div className="flex items-center gap-1">
                <code className="min-w-0 flex-1 truncate font-mono text-xs" data-testid="pairing-code">
                  {pairing.code}
                </code>
                <CopyButton text={pairing.code} label="Pairing code" />
                <CopyButton text={pairing.url} label="Pairing link" />
              </div>
              <p className="text-muted-foreground">Works once, for {countdown(left)}.</p>
            </>
          )}
          {pairing !== null && left <= 0 && (
            <div className="space-y-2">
              <p className="text-muted-foreground">The code expired.</p>
              <Button size="sm" variant="outline" onClick={start}>
                <RefreshCw />
                New code
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RenameForm({
  device,
  busy,
  onSave,
  onCancel,
}: {
  device: DeviceInfo
  busy: boolean
  onSave: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(device.name)
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-2 max-md:basis-full"
      onSubmit={(event) => {
        event.preventDefault()
        onSave(name.trim())
      }}
    >
      <Input
        aria-label={`New name for ${device.name}`}
        autoComplete="off"
        className="w-52 max-md:w-full max-md:flex-1"
        maxLength={DEVICE_NAME_MAX}
        value={name}
        onChange={(event) => {
          setName(event.target.value)
        }}
      />
      <Button type="submit" size="sm" disabled={busy || name.trim() === ''}>
        <Save />
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
        <X />
        Cancel
      </Button>
    </form>
  )
}

/** Agent titles on this phone's widgets; off, the home screen shows generic labels instead. */
function NamesToggle({ device, busy, onSet }: { device: DeviceInfo; busy: boolean; onSet: (show: boolean) => void }) {
  const id = `device-names-${device.id}`
  return (
    <div
      className="flex items-center gap-1.5 px-2 text-xs"
      title="Show agent names and reasons on this phone's widgets. Off shows generic labels on the home screen."
    >
      <Tag className="size-3.5 text-muted-foreground" />
      <label htmlFor={id}>Names</label>
      <Switch id={id} checked={device.show_names} disabled={busy} onCheckedChange={onSet} />
    </div>
  )
}

function DeviceRow({ device, onChange }: { device: DeviceInfo; onChange: () => void }) {
  const confirm = useConfirm()
  const { busy, run } = useBusy()
  const [renaming, setRenaming] = useState(false)

  const revoke = async () => {
    const message = `Revoke ${device.name}?`
    const detail = 'Its widget stops updating at once. Pair it again to bring it back.'
    if (await confirm({ message, detail, confirmLabel: 'Revoke', variant: 'destructive' })) {
      if (await run(async () => apiDelete(`/devices/${device.id}`))) {
        onChange()
      }
    }
  }

  if (renaming) {
    return (
      <div className={ROW} data-testid="device">
        <RenameForm
          device={device}
          busy={busy}
          onCancel={() => {
            setRenaming(false)
          }}
          onSave={(name) => {
            void run(async () => apiPatch(`/devices/${device.id}`, { name })).then((done) => {
              if (done) {
                setRenaming(false)
                onChange()
              }
            })
          }}
        />
      </div>
    )
  }
  return (
    <div className={ROW} data-testid="device">
      <div className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-sm">{device.name}</span>
        <span className="truncate text-muted-foreground">
          {device.platform}, {device.scopes.join(', ')}, paired <RelativeTime iso={device.created_at} />
          {device.last_seen_at === null ? (
            ', not seen yet'
          ) : (
            <>
              , seen <RelativeTime iso={device.last_seen_at} />
            </>
          )}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1 max-md:basis-full max-md:justify-end">
        <NamesToggle
          device={device}
          busy={busy}
          onSet={(show) => {
            void run(async () => apiPut(`/devices/${device.id}/widget`, { show_names: show })).then((done) => {
              if (done) {
                onChange()
              }
            })
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setRenaming(true)
          }}
        >
          <Pencil />
          Rename
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revoke()}>
          <Trash2 />
          Revoke
        </Button>
      </div>
    </div>
  )
}

function DevicesCard({ devices, onChange }: { devices: DeviceInfo[]; onChange: () => void }) {
  const [pairing, setPairing] = useState(false)
  const known = useMemo(() => devices.map((device) => device.id), [devices])
  const close = useCallback(() => {
    setPairing(false)
  }, [])
  const paired = useCallback(() => {
    setPairing(false)
    onChange()
  }, [onChange])
  return (
    <SettingsCard
      id="phones"
      title="Phones"
      actions={
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setPairing(true)
          }}
        >
          <Smartphone />
          Pair phone
        </Button>
      }
    >
      {devices.length === 0 ? (
        <p className="px-3 py-3 text-muted-foreground">No phone is paired. Pair one to see agents on its widget.</p>
      ) : (
        devices.map((device) => <DeviceRow key={device.id} device={device} onChange={onChange} />)
      )}
      {pairing && <PairDialog known={known} onPaired={paired} onClose={close} />}
    </SettingsCard>
  )
}

interface Loaded {
  devices: DeviceInfo[]
  android: AndroidAppSettings
}

/** Paired phones and the Android apps that may open Seti, loaded on their own. */
export function DeviceCards() {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    Promise.all([apiGet<DeviceInfo[]>('/devices'), apiGet<AndroidAppSettings>('/devices/android')]).then(
      ([devices, android]) => {
        setLoaded({ devices, android })
      },
      (e: unknown) => {
        setError(errorText(e))
      },
    )
  }, [])
  useEffect(load, [load])
  useMovedCard(loaded !== null)
  if (loaded === null) {
    return (
      <p className={error === '' ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>
        {error === '' ? 'Loading...' : error}
      </p>
    )
  }
  return (
    <>
      <DevicesCard devices={loaded.devices} onChange={load} />
      <AndroidCard
        settings={loaded.android}
        onChange={(android) => {
          setLoaded({ ...loaded, android })
        }}
      />
    </>
  )
}
