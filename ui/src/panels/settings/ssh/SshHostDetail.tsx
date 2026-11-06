import { sshHostRenameInput, type SshCheck, type SshHost, type SshStatus } from '@seti/shared'
import { ArrowLeft, CircleCheck, CircleX, ScanSearch, ShieldCheck, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiGet, apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { SettingsLink } from '@/components/SettingsLink'
import { PageHeader } from '@/components/crud/PageHeader'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { navigate } from '@/lib/route'
import { cn } from '@/lib/utils'
import { SettingRow, SettingsBody, SettingsCard } from '../layout'
import { RenameTitle } from './RenameTitle'
import { SshHostDefault } from './SshHostDefault'
import { HostFactsCard } from './SshHostFields'
import { takeCheckRequest, type SshState } from './ssh-state'

type Update = (next: SshStatus) => void

const toList = () => {
  navigate('settings', 'ssh')
}

function ListBack() {
  return (
    <Button variant="ghost" size="icon-sm" className="-ml-2 shrink-0" aria-label="Back to SSH" onClick={toList}>
      <ArrowLeft />
    </Button>
  )
}

interface HostCheck {
  check: SshCheck | null
  busy: boolean
  run: () => void
  clear: () => void
}

/** Checks a host on demand: the host keys it offers and a login with its key. */
function useHostCheck(alias: string): HostCheck {
  const [check, setCheck] = useState<SshCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const run = useCallback(() => {
    setBusy(true)
    apiPost<SshCheck>(`/ssh/hosts/${alias}/check`, {})
      .then(setCheck, (e: unknown) => {
        toast.error(errorText(e))
      })
      .finally(() => {
        setBusy(false)
      })
  }, [alias])
  const clear = useCallback(() => {
    setCheck(null)
  }, [])
  return { check, busy, run, clear }
}

function LoginResult({ check }: { check: SshCheck }) {
  const { ok, detail } = check.login
  const Icon = ok ? CircleCheck : CircleX
  return (
    <p
      role="status"
      aria-label="SSH login"
      className={cn('flex items-start gap-1.5 break-all', ok ? 'text-success' : 'text-destructive')}
    >
      <Icon className="mt-px size-3.5 shrink-0" aria-hidden />
      {ok ? detail : `Login failed: ${detail}`}
    </p>
  )
}

function CheckResult({ check, onUpdate }: { check: SshCheck; onUpdate: Update }) {
  const [busy, setBusy] = useState(false)
  const unknown = check.keys.filter((key) => !key.known)
  const trust = async () => {
    setBusy(true)
    try {
      onUpdate(await apiPost<SshStatus>('/ssh/known-hosts', { lines: unknown.map((key) => key.line) }))
      toast.success(`${check.alias} trusted`)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-1.5 border-t border-border px-3 py-2">
      <LoginResult check={check} />
      {check.keys.length === 0 ? (
        <p className="text-muted-foreground">
          No host keys found. Check the address, and for a jump host that it is trusted.
        </p>
      ) : (
        <ul aria-label={`Host keys of ${check.alias}`} className="space-y-0.5 font-mono text-2xs">
          {check.keys.map((key) => (
            <li key={key.line} className="break-all">
              {key.key_type} {key.fingerprint} {key.known ? '(trusted)' : ''}
            </li>
          ))}
        </ul>
      )}
      {unknown.length > 0 && (
        <Hint text="Compare the fingerprints with the host's own before trusting them">
          <Button size="xs" onClick={() => void trust()} disabled={busy}>
            <ShieldCheck />
            Trust
          </Button>
        </Hint>
      )}
    </div>
  )
}

/** The host keys sandboxes pin for this host; a check fetches them and tries the host's key. */
function HostKeysCard({ host, checker, onUpdate }: { host: SshHost; checker: HostCheck; onUpdate: Update }) {
  const keyless = host.key_id === null
  const forget = async () => {
    try {
      await apiDelete(`/ssh/known-hosts?host=${encodeURIComponent(host.known_name)}`)
      onUpdate(await apiGet<SshStatus>('/ssh'))
      checker.clear()
      toast.success(`${host.known_name} no longer trusted`)
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  const button = (
    <Button size="sm" variant="outline" onClick={checker.run} disabled={keyless || checker.busy}>
      <ScanSearch />
      {checker.busy ? 'Checking...' : 'Check host'}
    </Button>
  )
  return (
    <SettingsCard
      title="Host keys"
      actions={
        <Hint text={keyless ? 'Choose a key first' : 'Fetch its host keys and log in with its key, from this machine'}>
          {keyless ? <span>{button}</span> : button}
        </Hint>
      }
    >
      {host.host_keys.length === 0 ? (
        <p className="p-3 text-warning-text">
          {keyless
            ? 'Choose a key above, then check the host to see its host key.'
            : 'Not trusted yet: agents cannot connect until you check the host and trust its key.'}
        </p>
      ) : (
        <div className="flex items-start justify-between gap-3 p-3">
          <ul aria-label="Trusted host keys" className="min-w-0">
            {host.host_keys.map((entry) => (
              <li key={entry.key_type} className="truncate font-mono text-2xs text-muted-foreground">
                {entry.key_type} {entry.fingerprint}
              </li>
            ))}
          </ul>
          <Hint text={`Stop trusting the keys of ${host.known_name}`}>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Forget ${host.known_name}`}
              onClick={() => void forget()}
            >
              <Trash2 />
            </Button>
          </Hint>
        </div>
      )}
      {checker.check !== null && <CheckResult check={checker.check} onUpdate={onUpdate} />}
    </SettingsCard>
  )
}

/** The credentials that bundle this host, each a link to the set where that changes. */
function SetLinks({ host }: { host: SshHost }) {
  if (host.sets.length === 0) {
    return <span className="text-muted-foreground">None</span>
  }
  return (
    <span className="flex flex-wrap gap-x-2">
      {host.sets.map((set) => (
        <SettingsLink key={set.id} page="credentials" detail={set.id}>
          {set.name}
        </SettingsLink>
      ))}
    </span>
  )
}

function DeleteHost({ host, onUpdate }: { host: SshHost; onUpdate: Update }) {
  const confirm = useConfirm()
  const remove = async () => {
    const message = `Agents lose ${host.alias}, with its default, each agent's choice and its place in any credential. Its trusted host keys go when no other host uses them.`
    if (!(await confirm({ title: `Delete ${host.alias}`, message, confirmLabel: 'Delete', variant: 'destructive' }))) {
      return
    }
    try {
      await apiDelete(`/ssh/hosts/${host.alias}`)
      onUpdate(await apiGet<SshStatus>('/ssh'))
      toast.success(`Deleted ${host.alias}`)
      navigate('settings', 'ssh', { force: true })
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  return (
    <Button size="sm" variant="outline" onClick={() => void remove()}>
      <Trash2 />
      Delete
    </Button>
  )
}

/** Renames the host; its sets, defaults and the hosts jumping through it follow. */
function HostTitle({ host, onUpdate }: { host: SshHost; onUpdate: Update }) {
  const rename = async (next: string) => {
    const parsed = sshHostRenameInput.safeParse({ alias: next })
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the name')
      return false
    }
    try {
      onUpdate(await apiPost<SshStatus>(`/ssh/hosts/${host.alias}/rename`, parsed.data))
      toast.success(`Renamed to ${parsed.data.alias}`)
      window.location.replace(`#settings/ssh/${parsed.data.alias}`)
      return true
    } catch (e) {
      toast.error(errorText(e))
      return false
    }
  }
  return (
    <RenameTitle
      name={host.alias}
      label="Rename host"
      note="Agents use the new name from their next turn."
      onRename={rename}
    />
  )
}

function HostPage({ host, status, onUpdate }: { host: SshHost; status: SshStatus; onUpdate: Update }) {
  const checker = useHostCheck(host.alias)
  const { run } = checker
  const hasKey = host.key_id !== null
  useEffect(() => {
    if (hasKey && takeCheckRequest(host.alias)) {
      run()
    }
  }, [hasKey, host.alias, run])
  return (
    <div className="space-y-4">
      <HostFactsCard
        key={host.updated_at}
        host={host}
        status={status}
        onUpdate={onUpdate}
        onSaved={(recheck) => {
          if (recheck) {
            run()
          }
        }}
      />
      <HostKeysCard host={host} checker={checker} onUpdate={onUpdate} />
      <SettingsCard title="Agents">
        <SettingRow
          label="Default access"
          description="On gives this host to every agent without its own choice; one agent's Access can still turn it off."
        >
          <SshHostDefault host={host} onUpdate={onUpdate} />
        </SettingRow>
        <SettingRow label="Credentials" description="Every agent using one of these sets gets this host.">
          <SetLinks host={host} />
        </SettingRow>
      </SettingsCard>
    </div>
  )
}

/** One host: its key and login, its trusted host keys, its default and the sets bundling it. */
export function SshHostDetail({ alias, state }: { alias: string; state: SshState }) {
  const { status, error, setStatus } = state
  const host = status?.hosts.find((entry) => entry.alias === alias)
  if (status === null || host === undefined) {
    const loading = status === null && error === ''
    const message = status === null ? error : 'No such SSH host. It may have been deleted.'
    return (
      <SettingsBody narrow header={<PageHeader level={2} title={alias} back={<ListBack />} />}>
        <p className={loading ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>
          {loading ? 'Loading...' : message}
        </p>
      </SettingsBody>
    )
  }
  return (
    <SettingsBody
      narrow
      header={
        <PageHeader
          level={2}
          title={host.alias}
          heading={<HostTitle key={host.alias} host={host} onUpdate={setStatus} />}
          description={host.route}
          back={<ListBack />}
          actions={<DeleteHost host={host} onUpdate={setStatus} />}
        />
      }
    >
      <HostPage key={host.alias} host={host} status={status} onUpdate={setStatus} />
    </SettingsBody>
  )
}
