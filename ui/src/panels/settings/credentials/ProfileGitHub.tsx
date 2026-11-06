import { githubOwnerName, secretSetInput, type CredentialProfile, type GitHubOwnerToken } from '@seti/shared'
import { Plus, Save, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiPut, errorText } from '@/api'
import { RelativeTime } from '@/components/RelativeTime'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { Input } from '@/components/ui/input'
import { refreshSystem } from '@/hooks/useSystem'
import { SettingRow, SettingsCard } from '../layout'

type Changed = () => void

/** Validates and saves a token, the profile's default when owner is null; true when saved. */
async function saveToken(base: string, owner: string | null, value: string, onChanged: Changed): Promise<boolean> {
  const name = owner === null ? null : githubOwnerName.safeParse(owner)
  const token = secretSetInput.safeParse({ value })
  if (name?.success === false || !token.success) {
    toast.error((name?.error ?? token.error)?.issues[0]?.message ?? 'Check the owner and token')
    return false
  }
  const path = name === null ? `${base}/github` : `${base}/github/${encodeURIComponent(name.data)}`
  try {
    await apiPut<CredentialProfile>(path, token.data)
    onChanged()
    refreshSystem()
    toast.success(name === null ? 'GitHub token saved' : `GitHub token for ${name.data} saved`)
    return true
  } catch (e) {
    toast.error(errorText(e))
    return false
  }
}

function TokenRow({
  base,
  label,
  owner,
  updatedAt,
  onChanged,
}: {
  base: string
  label: string
  owner: string | null
  updatedAt: string | null
  onChanged: Changed
}) {
  const confirm = useConfirm()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const inputLabel = owner === null ? 'Default GitHub token' : `GitHub token for ${owner}`

  const save = async () => {
    setBusy(true)
    if (await saveToken(base, owner, value, onChanged)) {
      setValue('')
    }
    setBusy(false)
  }

  const clear = async () => {
    const message =
      owner === null
        ? 'Agents using this set lose the default GitHub token at their next start.'
        : `Agents using this set lose the GitHub token for ${owner} and fall back to the default token.`
    if (!(await confirm({ message, confirmLabel: 'Clear', variant: 'destructive' }))) {
      return
    }
    setBusy(true)
    try {
      const path = owner === null ? `${base}/github` : `${base}/github/${encodeURIComponent(owner)}`
      await apiDelete(path)
      refreshSystem()
      toast.success(owner === null ? 'GitHub token cleared' : `GitHub token for ${owner} cleared`)
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingRow
      label={label}
      stack
      description={
        updatedAt === null ? (
          'Not set'
        ) : (
          <>
            Set <RelativeTime iso={updatedAt} />
          </>
        )
      }
    >
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <Input
          type="password"
          aria-label={inputLabel}
          autoComplete="off"
          className="w-56 font-mono max-md:w-full"
          placeholder={updatedAt === null ? 'github_pat_...' : 'Replace'}
          value={value}
          onChange={(event) => {
            setValue(event.target.value)
          }}
        />
        <Button type="submit" size="sm" disabled={busy || value.trim() === ''}>
          <Save />
          Save
        </Button>
        {updatedAt !== null && (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void clear()}>
            <Trash2 />
            Clear
          </Button>
        )}
      </form>
    </SettingRow>
  )
}

function AddOwner({ base, onChanged }: { base: string; onChanged: Changed }) {
  const [owner, setOwner] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const add = async () => {
    setBusy(true)
    if (await saveToken(base, owner, value, onChanged)) {
      setOwner('')
      setValue('')
    }
    setBusy(false)
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2 p-3"
      onSubmit={(event) => {
        event.preventDefault()
        void add()
      }}
    >
      <Input
        aria-label="GitHub owner"
        autoComplete="off"
        className="w-40 font-mono max-md:w-full"
        placeholder="owner"
        value={owner}
        onChange={(event) => {
          setOwner(event.target.value)
        }}
      />
      <Input
        type="password"
        aria-label="GitHub token for the owner"
        autoComplete="off"
        className="w-56 font-mono max-md:w-full"
        placeholder="github_pat_..."
        value={value}
        onChange={(event) => {
          setValue(event.target.value)
        }}
      />
      <Button type="submit" size="sm" disabled={busy || owner.trim() === '' || value.trim() === ''}>
        <Plus />
        Add
      </Button>
    </form>
  )
}

/** A profile's fine-grained GitHub tokens: the default one and one per owner. */
export function ProfileGitHub({ profile, onChanged }: { profile: CredentialProfile; onChanged: Changed }) {
  const base = `/credentials/profiles/${profile.id}`
  const owners: GitHubOwnerToken[] = profile.github.owners
  return (
    <SettingsCard title="GitHub tokens">
      <p className="border-b border-border p-3 text-muted-foreground">
        Fine-grained tokens the proxy puts on the GitHub requests of agents using this set, in place of your gh login. A
        token reaches one user or organization: requests for an owner listed here use its token, the rest use the
        default.
      </p>
      <TokenRow
        base={base}
        label="Default"
        owner={null}
        updatedAt={profile.github.default.updated_at}
        onChanged={onChanged}
      />
      {owners.map((token) => (
        <TokenRow
          key={token.owner}
          base={base}
          label={token.owner}
          owner={token.owner}
          updatedAt={token.updated_at}
          onChanged={onChanged}
        />
      ))}
      <AddOwner base={base} onChanged={onChanged} />
    </SettingsCard>
  )
}
