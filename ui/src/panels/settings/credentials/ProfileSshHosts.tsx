import type { CredentialProfile, SshHost, SshStatus } from '@seti/shared'
import { TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiGet, apiPut, errorText } from '@/api'
import { SettingsLink } from '@/components/SettingsLink'
import { Switch } from '@/components/ui/switch'
import { navigate } from '@/lib/route'
import { SettingsCard } from '../layout'

function HostRow({
  host,
  profile,
  bundled,
  busy,
  onToggle,
}: {
  host: SshHost
  profile: CredentialProfile
  bundled: boolean
  busy: boolean
  onToggle: (on: boolean) => void
}) {
  return (
    <li aria-label={host.alias} className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
      <button
        type="button"
        className="min-w-0 flex-1 text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          navigate('settings', `ssh/${host.alias}`)
        }}
      >
        <span className="block truncate font-mono text-sm">{host.alias}</span>
        <span className="block truncate text-2xs text-muted-foreground">
          {host.user} at {host.route}
        </span>
        {host.key_id === null && (
          <span className="flex items-center gap-1 text-2xs text-warning-text">
            <TriangleAlert className="size-3 shrink-0" aria-hidden />
            No key yet
          </span>
        )}
      </button>
      <Switch
        aria-label={`${host.alias} in ${profile.name}`}
        checked={bundled}
        disabled={busy}
        onCheckedChange={onToggle}
      />
    </li>
  )
}

/** The SSH hosts every agent using these credentials gets, each switched on or off for the set. */
export function ProfileSshHosts({ profile, onChanged }: { profile: CredentialProfile; onChanged: () => void }) {
  const [status, setStatus] = useState<SshStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    apiGet<SshStatus>('/ssh').then(setStatus, (e: unknown) => {
      toast.error(errorText(e))
    })
  }, [])
  const toggle = async (alias: string, on: boolean) => {
    setBusy(alias)
    try {
      const path = `/credentials/profiles/${profile.id}/ssh-hosts/${alias}`
      await (on ? apiPut<CredentialProfile>(path, {}) : apiDelete(path))
      toast.success(on ? `${profile.name} agents get ${alias}` : `${alias} left ${profile.name}`)
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <SettingsCard title="SSH hosts">
      <p className="border-b border-border p-3 text-muted-foreground">
        Hosts switched on here reach every agent using {profile.name}, beside the hosts each agent turns on itself.
      </p>
      {status === null && <p className="p-3 text-muted-foreground">Loading...</p>}
      {status?.hosts.length === 0 && (
        <p className="p-3 text-muted-foreground">
          No SSH hosts yet; add them in <SettingsLink page="ssh">Settings, SSH</SettingsLink>.
        </p>
      )}
      {status !== null && status.hosts.length > 0 && (
        <ul aria-label="SSH hosts">
          {status.hosts.map((host) => (
            <HostRow
              key={host.alias}
              host={host}
              profile={profile}
              bundled={profile.ssh_hosts.includes(host.alias)}
              busy={busy !== null}
              onToggle={(on) => void toggle(host.alias, on)}
            />
          ))}
        </ul>
      )}
    </SettingsCard>
  )
}
