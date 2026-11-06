import { SSH_OPTION_NAMES, sshHostFields, type SshHost, type SshOption, type SshStatus } from '@seti/shared'
import { Plus, Save, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPut, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { useLeaveGuard } from '@/hooks/useLeaveGuard'
import { SettingRow, SettingsCard } from '../layout'
import { KeyPicker } from './KeyPicker'
import { keyChoice, keyChosen, resolveKey, type KeyChoice } from './key-choice'

const NO_JUMP = ''

/** Picks the host to connect through first, or none; a host cannot jump through itself. */
export function JumpSelect({
  alias,
  hosts,
  value,
  onChange,
}: {
  alias: string
  hosts: readonly SshHost[]
  value: string | null
  onChange: (jump: string | null) => void
}) {
  return (
    <NativeSelect
      aria-label="Jump host"
      className="w-56 max-md:w-full"
      value={value ?? NO_JUMP}
      onChange={(event) => {
        onChange(event.target.value === NO_JUMP ? null : event.target.value)
      }}
    >
      <NativeSelectOption value={NO_JUMP}>None, connect directly</NativeSelectOption>
      {hosts
        .filter((host) => host.alias !== alias)
        .map((host) => (
          <NativeSelectOption key={host.alias} value={host.alias}>
            {host.alias}
          </NativeSelectOption>
        ))}
    </NativeSelect>
  )
}

function OptionRow({
  option,
  index,
  onChange,
  onRemove,
}: {
  option: SshOption
  index: number
  onChange: (next: SshOption) => void
  onRemove: () => void
}) {
  const label = `Option ${String(index + 1)}`
  return (
    <li className="flex flex-wrap items-center gap-2">
      <NativeSelect
        aria-label={`${label} name`}
        className="w-56 max-md:w-full"
        value={option.name}
        onChange={(event) => {
          onChange({ ...option, name: event.target.value })
        }}
      >
        {SSH_OPTION_NAMES.map((name) => (
          <NativeSelectOption key={name} value={name}>
            {name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Input
        aria-label={`${label} value`}
        autoComplete="off"
        className="w-40 font-mono max-md:flex-1"
        value={option.value}
        onChange={(event) => {
          onChange({ ...option, value: event.target.value })
        }}
      />
      <Button size="icon-xs" variant="ghost" aria-label={`Remove ${option.name}`} onClick={onRemove}>
        <X />
      </Button>
    </li>
  )
}

interface Form {
  hostname: string
  port: string
  user: string
  jump: string | null
  options: SshOption[]
}

const toForm = (host: SshHost): Form => ({
  hostname: host.hostname,
  port: String(host.port),
  user: host.user,
  jump: host.jump,
  options: host.options,
})

const sameForm = (a: Form, b: Form) => JSON.stringify(a) === JSON.stringify(b)

/** Whether a save changes where ssh goes or how it logs in, so the host wants checking again. */
const reachChanged = (before: Form, after: Form, keyChanged: boolean) =>
  keyChanged || (['hostname', 'port', 'user', 'jump'] as const).some((field) => before[field] !== after[field])

/** Host fields checked before a new key is made, so a bad host name makes no stray key. */
const hostOnly = sshHostFields.omit({ key_id: true })

/**
 * How ssh logs in to a host: its one key first, then address, port, user, jump host and safe
 * options. `onSaved` hears whether the save changed the login, to check the host again.
 */
export function HostFactsCard({
  host,
  status,
  onUpdate,
  onSaved,
}: {
  host: SshHost
  status: SshStatus
  onUpdate: (next: SshStatus) => void
  onSaved: (recheck: boolean) => void
}) {
  const [form, setForm] = useState<Form>(() => toForm(host))
  const [choice, setChoice] = useState<KeyChoice>(() => keyChoice(host.key_id))
  const [saving, setSaving] = useState(false)
  const keyChanged = choice.keyId !== (host.key_id ?? '')
  const dirty = keyChanged || !sameForm(form, toForm(host))
  useLeaveGuard(dirty)
  const patch = (next: Partial<Form>) => {
    setForm((prev) => ({ ...prev, ...next }))
  }
  const setOption = (index: number, next: SshOption | null) => {
    patch({
      options: next === null ? form.options.filter((_, at) => at !== index) : form.options.with(index, next),
    })
  }
  const save = async () => {
    const parsed = hostOnly.safeParse(form)
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the host')
      return
    }
    setSaving(true)
    try {
      const keyId = await resolveKey(choice)
      setChoice(keyChoice(keyId))
      const next = await apiPut<SshStatus>(`/ssh/hosts/${host.alias}`, { ...parsed.data, key_id: keyId })
      toast.success(`${host.alias} saved`)
      onSaved(reachChanged(toForm(host), form, keyChanged))
      onUpdate(next)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }
  const unused = SSH_OPTION_NAMES.find((name) => !form.options.some((option) => option.name === name))
  return (
    <SettingsCard
      title="Connection"
      actions={
        <Button size="sm" onClick={() => void save()} disabled={!dirty || saving || !keyChosen(choice)}>
          <Save />
          {saving ? 'Saving...' : 'Save'}
        </Button>
      }
    >
      <SettingRow label="SSH key" stack description="Every host logs in as one user with one key.">
        <div className="w-72 max-md:w-full">
          <KeyPicker keys={status.keys} choice={choice} carried={host.key_id === null} onChange={setChoice} />
        </div>
      </SettingRow>
      <SettingRow label="Host name" stack description="A DNS name or IPv4 address, without user or port.">
        <Input
          aria-label="Host name"
          autoComplete="off"
          className="w-56 font-mono max-md:w-full"
          value={form.hostname}
          onChange={(event) => {
            patch({ hostname: event.target.value })
          }}
        />
      </SettingRow>
      <SettingRow label="User" stack>
        <Input
          aria-label="User"
          autoComplete="off"
          className="w-56 font-mono max-md:w-full"
          value={form.user}
          onChange={(event) => {
            patch({ user: event.target.value })
          }}
        />
      </SettingRow>
      <SettingRow label="Port" stack>
        <Input
          aria-label="Port"
          inputMode="numeric"
          className="w-24 font-mono max-md:w-full"
          value={form.port}
          onChange={(event) => {
            patch({ port: event.target.value })
          }}
        />
      </SettingRow>
      <SettingRow label="Jump host" stack description="Connect through this host first, with its own user and key.">
        <JumpSelect
          alias={host.alias}
          hosts={status.hosts}
          value={form.jump}
          onChange={(jump) => {
            patch({ jump })
          }}
        />
      </SettingRow>
      <div className="space-y-2 px-3 py-3">
        <div className="text-sm font-medium">SSH options</div>
        <p className="text-muted-foreground">
          Keepalives, timeouts and algorithms only. Seti refuses options that run commands, forward connections or read
          files, and sets host key checks itself.
        </p>
        {form.options.length > 0 && (
          <ul aria-label="SSH options" className="space-y-2">
            {form.options.map((option, index) => (
              <OptionRow
                key={index}
                option={option}
                index={index}
                onChange={(next) => {
                  setOption(index, next)
                }}
                onRemove={() => {
                  setOption(index, null)
                }}
              />
            ))}
          </ul>
        )}
        {unused !== undefined && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              patch({ options: [...form.options, { name: unused, value: '' }] })
            }}
          >
            <Plus />
            Option
          </Button>
        )}
      </div>
    </SettingsCard>
  )
}
