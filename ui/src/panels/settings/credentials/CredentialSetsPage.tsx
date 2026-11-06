import type { CredentialProfile } from '@seti/shared'
import { ChevronRight, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { CrudEditDialog, Field } from '@/components/crud/CrudForm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { navigate } from '@/lib/route'
import { SettingsBody, SettingsHeader, SettingsList } from '../layout'
import { AwsDefault } from './AwsDefault'
import { ProfileDetail } from './ProfileDetail'
import { BuiltinBadge } from './ProfileTitle'
import { AgentTokens } from './SecretCards'
import { profileFacts, validName } from './summary'
import { useCredentials } from './use-credentials'

const openProfile = (id: string) => {
  navigate('settings', `credentials/${id}`, { force: true })
}

function NewProfileDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const create = async () => {
    const valid = validName(name)
    if (valid === null) {
      return
    }
    setSaving(true)
    try {
      const created = await apiPost<CredentialProfile>('/credentials/profiles', { name: valid })
      toast.success(`Created ${created.name}`)
      setName('')
      onClose()
      openProfile(created.id)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <CrudEditDialog
      open={open}
      title="New credential"
      onCancel={onClose}
      onSave={() => void create()}
      saving={saving}
      saveLabel="Create"
      savingLabel="Creating..."
      saveIcon={Plus}
    >
      <Field label="Name" full>
        <Input
          aria-label="Name"
          placeholder="Client A"
          value={name}
          onChange={(event) => {
            setName(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void create()
            }
          }}
        />
      </Field>
      <p className="col-span-full text-xs text-muted-foreground">
        It starts with no tokens, no AWS role, no connections and no SSH hosts. Choose it for an agent in the agent's
        details.
      </p>
    </CrudEditDialog>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">{label}</dt>
      <dd className="wrap-anywhere">{value}</dd>
    </div>
  )
}

function ProfileRow({ profile }: { profile: CredentialProfile }) {
  const facts = profileFacts(profile)
  return (
    <li aria-label={profile.name} className="relative border-b border-border px-3 py-3 last:border-b-0 hover:bg-accent">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          className="min-w-0 truncate text-left text-sm font-medium outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
          onClick={() => {
            openProfile(profile.id)
          }}
        >
          {profile.name}
        </button>
        {profile.builtin && <BuiltinBadge />}
        <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden />
      </div>
      <dl className="mt-2 grid grid-cols-5 gap-x-4 gap-y-2 max-md:grid-cols-2">
        <Fact label="GitHub" value={facts.github} />
        <Fact label="AWS" value={facts.aws} />
        <Fact label="Connections" value={facts.connections} />
        <Fact label="SSH hosts" value={facts.ssh} />
        <Fact label="Used by" value={facts.agents} />
      </dl>
    </li>
  )
}

function SetDetail({ profileId }: { profileId: string }) {
  const { overview, error, reload } = useCredentials(profileId)
  return <ProfileDetail profileId={profileId} overview={overview} error={error} reload={reload} />
}

/** Every credential, the AWS default and the agent tokens; `setId` opens one credential. */
export function CredentialSetsPage({ setId }: { setId: string | null }) {
  return setId === null ? <SetList /> : <SetDetail profileId={setId} />
}

function SetList() {
  const { overview, error } = useCredentials(null)
  const [creating, setCreating] = useState(false)
  const profiles: readonly CredentialProfile[] | null = overview?.profiles ?? null
  return (
    <SettingsBody
      narrow
      header={
        <SettingsHeader
          title="Credentials"
          description="A credential is the bundle an agent picks: GitHub tokens, an AWS role, SSH hosts and the connections it carries. The Claude token below covers every agent. Saved values are never shown again."
          actions={
            <Hint text="New credential">
              <Button
                size="sm"
                onClick={() => {
                  setCreating(true)
                }}
              >
                <Plus />
                Credential
              </Button>
            </Hint>
          }
        />
      }
    >
      <div className="space-y-4">
        <SettingsList label="Credentials">
          {profiles === null ? (
            <p className={error === '' ? 'p-3 text-muted-foreground' : 'p-3 text-destructive'}>
              {error === '' ? 'Loading...' : error}
            </p>
          ) : (
            <ul aria-label="Credentials">
              {profiles.map((profile) => (
                <ProfileRow key={profile.id} profile={profile} />
              ))}
            </ul>
          )}
        </SettingsList>
        <AwsDefault />
        <AgentTokens />
      </div>
      <NewProfileDialog
        open={creating}
        onClose={() => {
          setCreating(false)
        }}
      />
    </SettingsBody>
  )
}
