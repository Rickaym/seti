import { sshKeyName, sshKeyUpdateInput, type SshKey, type SshKeyUpdateInput, type SshStatus } from '@seti/shared'
import { ArrowLeft, ChevronRight, Plus, Replace, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiPatch, errorText } from '@/api'
import { CopyButton } from '@/components/CopyButton'
import { Hint } from '@/components/Hint'
import { CrudEditDialog, Field } from '@/components/crud/CrudForm'
import { PageHeader } from '@/components/crud/PageHeader'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { navigate } from '@/lib/route'
import { SettingsBody, SettingsCard } from '../layout'
import { NewHostDialog } from './NewHostDialog'
import { RenameTitle } from './RenameTitle'
import { sourceText } from './key-choice'
import { PathField, PrivateKeyField } from './key-fields'
import { openHost, type SshState } from './ssh-state'

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

type Swap = 'paste' | 'file'

const isSwap = (value: string): value is Swap => value === 'paste' || value === 'file'

/** Swaps a key's private half for a pasted key or a file; every host that selects it follows. */
function SwapKeyDialog({ sshKey, onClose, onSaved }: { sshKey: SshKey; onClose: () => void; onSaved: () => void }) {
  const [swap, setSwap] = useState<Swap>(sshKey.source === 'file' ? 'file' : 'paste')
  const [privateKey, setPrivateKey] = useState('')
  const [file, setFile] = useState(sshKey.path ?? '')
  const [saving, setSaving] = useState(false)
  const save = async () => {
    const body: SshKeyUpdateInput = swap === 'paste' ? { private_key: privateKey } : { path: file }
    const parsed = sshKeyUpdateInput.safeParse(body)
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the key')
      return
    }
    setSaving(true)
    try {
      await apiPatch<SshKey>(`/ssh/keys/${sshKey.id}`, parsed.data)
      toast.success(`${sshKey.name} swapped`)
      onSaved()
      onClose()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }
  const users = sshKey.hosts.length === 0 ? 'No host uses it yet.' : `${sshKey.hosts.join(', ')} log in with it.`
  return (
    <CrudEditDialog
      open
      title={`Swap ${sshKey.name}`}
      onCancel={onClose}
      onSave={() => void save()}
      saving={saving}
      canSave={(swap === 'paste' ? privateKey : file).trim() !== ''}
      saveLabel="Swap"
      savingLabel="Swapping..."
      saveIcon={Replace}
    >
      <Field label="Source" full>
        <NativeSelect
          aria-label="Private key source"
          className="w-full"
          value={swap}
          onChange={(event) => {
            const next = event.target.value
            setSwap(isSwap(next) ? next : 'paste')
          }}
        >
          <NativeSelectOption value="paste">Paste a new private key</NativeSelectOption>
          <NativeSelectOption value="file">Key file on this machine</NativeSelectOption>
        </NativeSelect>
      </Field>
      <div className="col-span-full">
        {swap === 'paste' ? (
          <PrivateKeyField value={privateKey} onChange={setPrivateKey} />
        ) : (
          <PathField value={file} onChange={setFile} />
        )}
      </div>
      <p className="col-span-full text-xs text-muted-foreground">
        {users} The new private key applies to every host that uses this key from its agents&apos; next turn.
      </p>
    </CrudEditDialog>
  )
}

function KeyTitle({ sshKey, reload }: { sshKey: SshKey; reload: () => void }) {
  const rename = async (next: string) => {
    const parsed = sshKeyName.safeParse(next)
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the name')
      return false
    }
    try {
      await apiPatch<SshKey>(`/ssh/keys/${sshKey.id}`, { name: parsed.data })
      toast.success(`Renamed to ${parsed.data}`)
      reload()
      return true
    } catch (e) {
      toast.error(errorText(e))
      return false
    }
  }
  return <RenameTitle name={sshKey.name} label="Rename key" onRename={rename} />
}

function KeyActions({ sshKey, reload }: { sshKey: SshKey; reload: () => void }) {
  const confirm = useConfirm()
  const [changing, setChanging] = useState(false)
  const remove = async () => {
    const message = `The key ${sshKey.name} is deleted. It cannot be restored, only added again.`
    if (!(await confirm({ title: `Remove ${sshKey.name}`, message, confirmLabel: 'Remove', variant: 'destructive' }))) {
      return
    }
    try {
      await apiDelete(`/ssh/keys/${sshKey.id}`)
      toast.success(`${sshKey.name} removed`)
      navigate('settings', 'ssh', { force: true })
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  return (
    <>
      <Hint text="Swap its private key; every host using it follows">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setChanging(true)
          }}
        >
          <Replace />
          Swap
        </Button>
      </Hint>
      <Button size="sm" variant="outline" onClick={() => void remove()}>
        <Trash2 />
        Remove
      </Button>
      {changing && (
        <SwapKeyDialog
          sshKey={sshKey}
          onSaved={reload}
          onClose={() => {
            setChanging(false)
          }}
        />
      )}
    </>
  )
}

/** The hosts that log in with this key, each opening its host, and a new host with this key. */
function KeyHosts({ sshKey, status }: { sshKey: SshKey; status: SshStatus }) {
  const [adding, setAdding] = useState(false)
  const hosts = status.hosts.filter((host) => host.key_id === sshKey.id)
  return (
    <SettingsCard
      title="Hosts"
      actions={
        <Button
          size="sm"
          aria-label="Add host with this key"
          onClick={() => {
            setAdding(true)
          }}
        >
          <Plus />
          Add host
        </Button>
      }
    >
      {hosts.length === 0 ? (
        <p className="p-3 text-muted-foreground">No host logs in with this key yet.</p>
      ) : (
        <ul aria-label={`Hosts using ${sshKey.name}`}>
          {hosts.map((host) => (
            <li key={host.alias} className="border-b border-border last:border-b-0">
              <button
                type="button"
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent"
                onClick={() => {
                  openHost(host.alias)
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{host.alias}</span>
                  <span className="block truncate font-mono text-2xs text-muted-foreground">
                    {host.user}@{host.route}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <NewHostDialog
          status={status}
          keyId={sshKey.id}
          onClose={() => {
            setAdding(false)
          }}
        />
      )}
    </SettingsCard>
  )
}

/** One key: its public half to copy into authorized_keys, the hosts using it, and a new host. */
export function SshKeyDetail({ id, state }: { id: string; state: SshState }) {
  const { status, error, reload } = state
  const sshKey = status?.keys.find((entry) => entry.id === id)
  if (status === null || sshKey === undefined) {
    const loading = status === null && error === ''
    const message = status === null ? error : 'No such SSH key. It may have been removed.'
    return (
      <SettingsBody narrow header={<PageHeader level={2} title="SSH key" back={<ListBack />} />}>
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
          title={sshKey.name}
          heading={<KeyTitle key={sshKey.name} sshKey={sshKey} reload={reload} />}
          description={sourceText(sshKey)}
          back={<ListBack />}
          actions={<KeyActions sshKey={sshKey} reload={reload} />}
        />
      }
    >
      <div className="space-y-4">
        <SettingsCard title="Public key" actions={<CopyButton text={sshKey.public_key} label="Public key" />}>
          <div className="space-y-2 p-3">
            <p className="text-muted-foreground">Add it to authorized_keys on each host below.</p>
            <Input
              readOnly
              aria-label={`Public key of ${sshKey.name}`}
              className="font-mono text-2xs"
              value={sshKey.public_key}
            />
            <p className="truncate font-mono text-2xs text-muted-foreground">{sshKey.fingerprint}</p>
          </div>
        </SettingsCard>
        <KeyHosts sshKey={sshKey} status={status} />
      </div>
    </SettingsBody>
  )
}
