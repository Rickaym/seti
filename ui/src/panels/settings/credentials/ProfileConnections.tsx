import type { Connection, CredentialProfile } from '@seti/shared'
import { Plug } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { navigate } from '@/lib/route'
import { SettingsCard } from '../layout'

function ConnectionRow({
  connection,
  profile,
  busy,
  onToggle,
}: {
  connection: Connection
  profile: CredentialProfile
  busy: boolean
  onToggle: (on: boolean) => void
}) {
  return (
    <li
      aria-label={connection.name}
      className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
    >
      <div className="min-w-0 flex-1">
        <span className="block truncate font-mono text-sm">{connection.name}</span>
        <span className="block text-2xs wrap-anywhere text-muted-foreground">
          {connection.env} - {connection.hosts.length === 0 ? 'no hosts' : connection.hosts.join(', ')}
        </span>
      </div>
      <Switch
        aria-label={`${connection.name} in ${profile.name}`}
        checked={connection.profiles.some((entry) => entry.id === profile.id)}
        disabled={busy}
        onCheckedChange={onToggle}
      />
    </li>
  )
}

/** The connections this credential carries to its agents, each switched on or off here. */
export function ProfileConnections({ profile, onChanged }: { profile: CredentialProfile; onChanged: () => void }) {
  const [list, setList] = useState<Connection[] | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    apiGet<Connection[]>('/connections').then(setList, (e: unknown) => {
      toast.error(errorText(e))
    })
  }, [])
  useEffect(load, [load])

  const toggle = async (connection: Connection, on: boolean) => {
    const others = connection.profiles.map((entry) => entry.id).filter((id) => id !== profile.id)
    setBusy(true)
    try {
      await apiPut<Connection>(`/connections/${connection.id}/credentials`, {
        profile_ids: on ? [...others, profile.id] : others,
      })
      toast.success(on ? `${profile.name} agents get ${connection.env}` : `${connection.name} left ${profile.name}`)
      load()
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsCard
      title="Connections"
      actions={
        <Hint text="Add or change connections">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              navigate('settings', 'connections')
            }}
          >
            <Plug />
            Manage
          </Button>
        </Hint>
      }
    >
      <p className="border-b border-border p-3 text-muted-foreground">
        Agents using {profile.name} get each connection switched on here: its variable holds a placeholder, and
        Seti&apos;s proxy puts the value on its hosts only.
      </p>
      {list === null && <p className="p-3 text-muted-foreground">Loading...</p>}
      {list?.length === 0 && <p className="p-3 text-muted-foreground">No connections yet.</p>}
      {list !== null && list.length > 0 && (
        <ul aria-label="Connections">
          {list.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              profile={profile}
              busy={busy}
              onToggle={(on) => void toggle(connection, on)}
            />
          ))}
        </ul>
      )}
    </SettingsCard>
  )
}
