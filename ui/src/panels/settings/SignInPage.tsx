import { PASSKEY_NAME_MAX, type AuthSessionInfo, type AuthSettings, type PasskeyInfo } from '@seti/shared'
import { Check, LogOut, Pencil, Plus, Save, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, errorText, SIGN_IN_REQUIRED } from '@/api'
import { RelativeTime } from '@/components/RelativeTime'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useBusy } from '@/hooks/useBusy'
import { deviceLabel } from '@/lib/device'
import { addPasskey, defaultPasskeyName, passkeysWork } from '@/lib/passkeys'
import { DeviceCards } from './DeviceCards'
import { SettingRow, SettingsBody, SettingsCard, SettingsHeader } from './layout'

const ROW = 'flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0 max-md:flex-wrap'

function enforceText(settings: AuthSettings): string {
  if (settings.public_host === null) {
    return 'Seti has no public hostname. On this machine the local token and passkeys sign browsers in.'
  }
  if (!settings.cloudflare_access) {
    return `Always on: no Cloudflare Access guards ${settings.public_host}, so only a passkey opens it.`
  }
  return settings.enforced
    ? `Browsers on ${settings.public_host} need a passkey; Cloudflare Access alone no longer lets them in.`
    : `Cloudflare Access signs browsers in on ${settings.public_host}. Turn this on to require a passkey too.`
}

function EnforcementCard({ settings, onChange }: { settings: AuthSettings; onChange: (next: AuthSettings) => void }) {
  const { busy, run } = useBusy()
  const confirm = useConfirm()
  const locked = settings.public_host === null || !settings.cloudflare_access
  const blocked = !settings.enforced && settings.enforce_blocked !== null

  const toggle = async (enforced: boolean) => {
    if (enforced) {
      const message = `Every browser on ${settings.public_host ?? 'the public host'} will need a passkey.`
      const detail = 'Paired phones keep their device keys; on this machine the local token still signs in.'
      if (!(await confirm({ message, detail, confirmLabel: 'Require' }))) {
        return
      }
    }
    await run(async () => {
      onChange(await apiPut<AuthSettings>('/auth/enforcement', { enforced }))
    })
  }

  return (
    <SettingsCard title="Public hostname">
      <SettingRow
        label="Require passkey"
        description={
          <>
            {enforceText(settings)}
            {blocked && !locked && <span className="block text-foreground">{settings.enforce_blocked}</span>}
          </>
        }
      >
        <Switch
          aria-label="Require passkey"
          checked={settings.enforced || (settings.public_host !== null && !settings.cloudflare_access)}
          disabled={busy || locked || blocked}
          onCheckedChange={(enforced) => void toggle(enforced)}
        />
      </SettingRow>
    </SettingsCard>
  )
}

function RenameForm({
  passkey,
  busy,
  onSave,
  onCancel,
}: {
  passkey: PasskeyInfo
  busy: boolean
  onSave: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(passkey.name)
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-2 max-md:basis-full"
      onSubmit={(event) => {
        event.preventDefault()
        onSave(name.trim())
      }}
    >
      <Input
        aria-label={`New name for ${passkey.name}`}
        autoComplete="off"
        className="w-52 max-md:w-full max-md:flex-1"
        maxLength={PASSKEY_NAME_MAX}
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

function PasskeyRow({ passkey, onChange }: { passkey: PasskeyInfo; onChange: () => void }) {
  const confirm = useConfirm()
  const { busy, run } = useBusy()
  const [renaming, setRenaming] = useState(false)

  const remove = async () => {
    const message = `Remove the passkey ${passkey.name}?`
    const detail = 'Browsers it signed in are signed out. Delete it from the device or password manager too.'
    if (await confirm({ message, detail, confirmLabel: 'Remove', variant: 'destructive' })) {
      if (await run(async () => apiDelete(`/auth/passkeys/${passkey.id}`))) {
        onChange()
      }
    }
  }

  return (
    <div className={ROW} data-testid="passkey">
      {renaming ? (
        <RenameForm
          passkey={passkey}
          busy={busy}
          onCancel={() => {
            setRenaming(false)
          }}
          onSave={(name) => {
            void run(async () => apiPatch(`/auth/passkeys/${passkey.id}`, { name })).then((done) => {
              if (done) {
                setRenaming(false)
                onChange()
              }
            })
          }}
        />
      ) : (
        <>
          <div className="grid min-w-0 flex-1 gap-0.5">
            <span className="truncate text-sm">{passkey.name}</span>
            <span className="truncate text-muted-foreground">
              {passkey.rp_id}, {passkey.synced ? 'synced' : 'this device only'}, added{' '}
              <RelativeTime iso={passkey.created_at} />
              {passkey.last_used_at !== null && (
                <>
                  , used <RelativeTime iso={passkey.last_used_at} />
                </>
              )}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1 max-md:basis-full max-md:justify-end">
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
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove()}>
              <Trash2 />
              Remove
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function PasskeysCard({ passkeys, onChange }: { passkeys: PasskeyInfo[]; onChange: () => void }) {
  const { busy, run } = useBusy()
  const add = async () => {
    if (await run(async () => addPasskey(defaultPasskeyName()))) {
      toast.success('Passkey added')
      onChange()
    }
  }
  return (
    <SettingsCard
      title="Passkeys"
      actions={
        passkeysWork() && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void add()}>
            <Plus />
            Add
          </Button>
        )
      }
    >
      {passkeys.length === 0 ? (
        <p className="px-3 py-3 text-muted-foreground">
          No passkeys yet. Add one here, on each host name you open Seti at.
        </p>
      ) : (
        passkeys.map((passkey) => <PasskeyRow key={passkey.id} passkey={passkey} onChange={onChange} />)
      )}
    </SettingsCard>
  )
}

function SessionRow({ session, onChange }: { session: AuthSessionInfo; onChange: () => void }) {
  const { busy, run } = useBusy()
  const signOut = async () => {
    if (session.current) {
      if (await run(async () => apiPost('/auth/signout', {}))) {
        window.dispatchEvent(new Event(SIGN_IN_REQUIRED))
      }
      return
    }
    if (await run(async () => apiDelete(`/auth/sessions/${session.id}`))) {
      onChange()
    }
  }
  return (
    <div className={ROW} data-testid="auth-session">
      <div className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <span className="truncate">{deviceLabel(session.user_agent)}</span>
          {session.current && (
            <span className="flex shrink-0 items-center gap-1 text-2xs text-success">
              <Check className="size-3" />
              This browser
            </span>
          )}
        </span>
        <span className="truncate text-muted-foreground">
          {session.host}
          {session.ip === null ? '' : ` from ${session.ip}`}
          {session.passkey_name === null ? '' : `, ${session.passkey_name}`}, active{' '}
          <RelativeTime iso={session.last_seen_at} />
        </span>
      </div>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void signOut()}>
        <LogOut />
        Sign out
      </Button>
    </div>
  )
}

function SessionsCard({ sessions, onChange }: { sessions: AuthSessionInfo[]; onChange: () => void }) {
  return (
    <SettingsCard title="Browsers">
      {sessions.length === 0 ? (
        <p className="px-3 py-3 text-muted-foreground">No browser is signed in with a passkey.</p>
      ) : (
        sessions.map((session) => <SessionRow key={session.id} session={session} onChange={onChange} />)
      )}
    </SettingsCard>
  )
}

interface Loaded {
  settings: AuthSettings
  passkeys: PasskeyInfo[]
  sessions: AuthSessionInfo[]
}

/** Who can open Seti: the require-passkey switch, passkeys, sessions, paired phones and apps. */
export function SignInPage() {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    Promise.all([
      apiGet<AuthSettings>('/auth/settings'),
      apiGet<PasskeyInfo[]>('/auth/passkeys'),
      apiGet<AuthSessionInfo[]>('/auth/sessions'),
    ]).then(
      ([settings, passkeys, sessions]) => {
        setLoaded({ settings, passkeys, sessions })
      },
      (e: unknown) => {
        setError(errorText(e))
      },
    )
  }, [])
  useEffect(load, [load])
  return (
    <SettingsBody
      narrow
      header={
        <SettingsHeader
          title="Sign-in"
          description="Who can open Seti: browsers sign in with passkeys, paired phones with a device key."
        />
      }
    >
      {loaded === null ? (
        <p className={error === '' ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>
          {error === '' ? 'Loading...' : error}
        </p>
      ) : (
        <div className="space-y-4">
          <EnforcementCard
            settings={loaded.settings}
            onChange={(settings) => {
              setLoaded({ ...loaded, settings })
            }}
          />
          <PasskeysCard passkeys={loaded.passkeys} onChange={load} />
          <SessionsCard sessions={loaded.sessions} onChange={load} />
          <DeviceCards />
        </div>
      )}
    </SettingsBody>
  )
}
