import type { SshHost, SshKey, SshKnownHost, SshStatus } from '@seti/shared'
import { ChevronRight, KeyRound, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiGet, errorText } from '@/api'
import { CopyButton } from '@/components/CopyButton'
import { Hint } from '@/components/Hint'
import { SettingsLink } from '@/components/SettingsLink'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { SettingsBody, SettingsCard, SettingsHeader } from '../layout'
import { useMovedCard } from '../use-moved-card'
import { NewHostDialog } from './NewHostDialog'
import { NewKeyDialog } from './NewKeyDialog'
import { SshHostDefault } from './SshHostDefault'
import { SshHostDetail } from './SshHostDetail'
import { SshKeyDetail } from './SshKeyDetail'
import { sourceText } from './key-choice'
import { KEY_ROUTE, openHost, openKey, useSshStatus, type SshState } from './ssh-state'

const CHIP =
  'relative flex max-w-44 shrink-0 items-center gap-1 justify-self-start border px-1.5 py-px text-2xs max-md:col-start-1 max-md:row-start-2 pointer-coarse:after:absolute pointer-coarse:after:-inset-2'

/** The one key a host logs in with, opening that key; a warning that opens the host when none. */
function KeyChip({ host }: { host: SshHost }) {
  if (host.key_id === null || host.key_name === null) {
    return (
      <Hint text="No key: choose one on the host">
        <button
          type="button"
          aria-label={`No key for ${host.alias}`}
          className={cn(CHIP, 'border-warning/60 bg-warning/10 text-warning-text hover:bg-warning/20')}
          onClick={() => {
            openHost(host.alias)
          }}
        >
          <TriangleAlert className="size-3 shrink-0" aria-hidden />
          No key
        </button>
      </Hint>
    )
  }
  const { key_id: keyId, key_name: name } = host
  return (
    <Hint text={`Logs in with ${name}`}>
      <button
        type="button"
        aria-label={`Key ${name}`}
        className={cn(CHIP, 'border-border text-foreground hover:bg-accent')}
        onClick={() => {
          openKey(keyId)
        }}
      >
        <KeyRound className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{name}</span>
      </button>
    </Hint>
  )
}

function HostRow({ host, onUpdate }: { host: SshHost; onUpdate: (next: SshStatus) => void }) {
  const untrusted = host.key_id !== null && host.host_keys.length === 0
  return (
    <li
      aria-label={host.alias}
      className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 last:border-b-0 max-md:grid-cols-[minmax(0,1fr)_auto_auto]"
    >
      <button
        type="button"
        className="min-w-0 flex-1 text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          openHost(host.alias)
        }}
      >
        <span className="block truncate text-sm font-medium">{host.alias}</span>
        <span className="block truncate font-mono text-2xs text-muted-foreground">
          {host.user}@{host.route}
        </span>
        {host.sets.length > 0 && (
          <span className="block truncate text-2xs text-muted-foreground">
            In {host.sets.map((set) => set.name).join(', ')}
          </span>
        )}
        {untrusted && (
          <span className="flex items-center gap-1 text-2xs text-warning-text">
            <TriangleAlert className="size-3 shrink-0" aria-hidden />
            No trusted host key yet: check it
          </span>
        )}
      </button>
      <KeyChip host={host} />
      <SshHostDefault host={host} onUpdate={onUpdate} />
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </li>
  )
}

/** Trusted keys of addresses no host uses any more, as after a host moved. */
function OtherKeysCard({ keys, onUpdate }: { keys: SshKnownHost[]; onUpdate: (next: SshStatus) => void }) {
  const forget = async (host: string) => {
    try {
      await apiDelete(`/ssh/known-hosts?host=${encodeURIComponent(host)}`)
      onUpdate(await apiGet<SshStatus>('/ssh'))
      toast.success(`${host} no longer trusted`)
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  const hosts = [...new Set(keys.map((entry) => entry.host))]
  return (
    <SettingsCard title="Other trusted host keys">
      <p className="border-b border-border p-3 text-muted-foreground">Keys of addresses no host uses now.</p>
      <ul aria-label="Other trusted host keys">
        {hosts.map((host) => (
          <li
            key={host}
            className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0"
          >
            <div className="min-w-0">
              <div className="font-mono text-sm">{host}</div>
              {keys
                .filter((entry) => entry.host === host)
                .map((entry) => (
                  <div key={entry.key_type} className="truncate font-mono text-2xs text-muted-foreground">
                    {entry.key_type} {entry.fingerprint}
                  </div>
                ))}
            </div>
            <Button size="icon-xs" variant="ghost" aria-label={`Forget ${host}`} onClick={() => void forget(host)}>
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
    </SettingsCard>
  )
}

/** How many hosts log in with a key, each a link to its host. */
function HostLinks({ sshKey }: { sshKey: SshKey }) {
  const count = sshKey.hosts.length
  if (count === 0) {
    return <span>Unused</span>
  }
  return (
    <span>
      Used by {count} {count === 1 ? 'host' : 'hosts'}:{' '}
      {sshKey.hosts.map((alias, index) => (
        <span key={alias}>
          {index > 0 && ', '}
          <SettingsLink page="ssh" detail={alias}>
            {alias}
          </SettingsLink>
        </span>
      ))}
    </span>
  )
}

function KeyRow({ sshKey }: { sshKey: SshKey }) {
  return (
    <li aria-label={sshKey.name} className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="block max-w-full truncate text-left text-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            openKey(sshKey.id)
          }}
        >
          {sshKey.name}
        </button>
        <div className="truncate font-mono text-2xs text-muted-foreground">{sshKey.fingerprint}</div>
        <div className="text-2xs text-muted-foreground">
          {sourceText(sshKey)}. <HostLinks sshKey={sshKey} />
        </div>
      </div>
      <CopyButton text={sshKey.public_key} label="Public key" />
    </li>
  )
}

/** A card's New button, named for what it adds; the card title says where. */
function NewButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Hint text={label}>
      <Button size="sm" aria-label={label} onClick={onClick}>
        <Plus />
        New
      </Button>
    </Hint>
  )
}

/** The keys hosts select, each with the hosts using it; first, since a host needs a key. */
function KeysCard({ status, reload }: { status: SshStatus; reload: () => void }) {
  const [creating, setCreating] = useState(false)
  return (
    <SettingsCard
      id="ssh-keys"
      title="SSH keys"
      actions={
        <NewButton
          label="New SSH key"
          onClick={() => {
            setCreating(true)
          }}
        />
      }
    >
      {status.keys.length === 0 ? (
        <p className="p-3 text-muted-foreground">No keys yet. Add one, or make one with a new host.</p>
      ) : (
        <ul aria-label="SSH keys">
          {status.keys.map((sshKey) => (
            <KeyRow key={sshKey.id} sshKey={sshKey} />
          ))}
        </ul>
      )}
      {creating && (
        <NewKeyDialog
          onAdded={reload}
          onClose={() => {
            setCreating(false)
          }}
        />
      )}
    </SettingsCard>
  )
}

/** Every host with its key, sets and default. */
function HostsCard({ status, setStatus }: { status: SshStatus; setStatus: (next: SshStatus) => void }) {
  const [creating, setCreating] = useState(false)
  return (
    <SettingsCard
      id="ssh-hosts"
      title="SSH hosts"
      actions={
        <NewButton
          label="New SSH host"
          onClick={() => {
            setCreating(true)
          }}
        />
      }
    >
      {status.hosts.length === 0 ? (
        <p className="p-3 text-muted-foreground">No hosts yet.</p>
      ) : (
        <ul aria-label="SSH hosts">
          {status.hosts.map((host) => (
            <HostRow key={host.alias} host={host} onUpdate={setStatus} />
          ))}
        </ul>
      )}
      {creating && (
        <NewHostDialog
          status={status}
          onClose={() => {
            setCreating(false)
          }}
        />
      )}
    </SettingsCard>
  )
}

/** Keys, then the hosts that pick them, then trusted keys of addresses no host uses. */
function SshList({ state }: { state: SshState }) {
  const { status, error, setStatus, reload } = state
  const loaded = status !== null
  useMovedCard(loaded)
  return (
    <SettingsBody
      narrow
      header={
        <SettingsHeader
          title="SSH"
          description="Each host logs in as one user with one key. An agent gets a host when its Access or its credential turns it on, and its sandbox gets only the keys of its hosts. Seti never shows a private key."
        />
      }
    >
      {status === null ? (
        <p className={error === '' ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>
          {error === '' ? 'Loading...' : error}
        </p>
      ) : (
        <div className="space-y-4">
          <KeysCard status={status} reload={reload} />
          <HostsCard status={status} setStatus={setStatus} />
          {status.other_host_keys.length > 0 && <OtherKeysCard keys={status.other_host_keys} onUpdate={setStatus} />}
        </div>
      )}
    </SettingsBody>
  )
}

/** The SSH page's route: a key under `keys/<id>`, a host under its alias, else the list. */
export function SshPage({ detail }: { detail: string | null }) {
  const keyId = detail?.startsWith(KEY_ROUTE) === true ? detail.slice(KEY_ROUTE.length) : null
  const state = useSshStatus(detail)
  if (keyId !== null) {
    return <SshKeyDetail id={keyId} state={state} />
  }
  return detail === null ? <SshList state={state} /> : <SshHostDetail alias={detail} state={state} />
}
