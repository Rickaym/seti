import type { CredentialProfile, CredentialsOverview } from '@seti/shared'
import { ArrowLeft, Check, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiDelete, errorText } from '@/api'
import { PageHeader } from '@/components/crud/PageHeader'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { navigate } from '@/lib/route'
import { SettingsBody } from '../layout'
import { ProfileAgents } from './ProfileAgents'
import { ProfileAws } from './ProfileAws'
import { ProfileConnections } from './ProfileConnections'
import { ProfileGitHub } from './ProfileGitHub'
import { ProfileSshHosts } from './ProfileSshHosts'
import { ProfileTitle } from './ProfileTitle'

const toList = () => {
  navigate('settings', 'credentials')
}

function ListBack() {
  return (
    <Button variant="ghost" size="icon-sm" className="-ml-2 shrink-0" aria-label="Back to credentials" onClick={toList}>
      <ArrowLeft />
    </Button>
  )
}

function deleteMessage(profile: CredentialProfile): string {
  const { agents } = profile
  const tokens = 'Its GitHub tokens and AWS role are deleted; its connections and SSH hosts leave its agents.'
  if (agents.length === 0) {
    return `${tokens} No agent uses it.`
  }
  const names = agents.map((agent) => agent.title).join(', ')
  const count = agents.length === 1 ? '1 agent uses it' : `${String(agents.length)} agents use it`
  return `${count}: ${names}. They move to Default. ${tokens}`
}

function DeleteProfile({ profile }: { profile: CredentialProfile }) {
  const confirm = useConfirm()
  const remove = async () => {
    const used = profile.agents.length > 0
    const ok = await confirm({
      title: `Delete ${profile.name}`,
      message: deleteMessage(profile),
      confirmLabel: used ? 'Move and delete' : 'Delete',
      variant: 'destructive',
    })
    if (!ok) {
      return
    }
    try {
      await apiDelete(`/credentials/profiles/${profile.id}`)
      toast.success(used ? `Deleted ${profile.name}; its agents use Default now` : `Deleted ${profile.name}`)
      navigate('settings', 'credentials', { force: true })
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

const DESCRIPTION = {
  builtin: 'Sandboxed agents use this credential unless their details choose another.',
  custom: 'What the sandbox proxy adds for the agents that use this credential.',
}

/** One credential: its name, tokens, AWS role, connections, SSH hosts and agents. */
export function ProfileDetail({
  profileId,
  overview,
  error,
  reload,
}: {
  profileId: string
  overview: CredentialsOverview | null
  error: string
  reload: () => void
}) {
  const profile = overview?.profiles.find((entry) => entry.id === profileId)
  if (overview === null || profile === undefined) {
    const loading = overview === null && error === ''
    const status = overview === null ? error : 'No such credential. It may have been deleted.'
    return (
      <SettingsBody narrow header={<PageHeader level={2} title="Credentials" back={<ListBack />} />}>
        <p className={loading ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>
          {loading ? 'Loading...' : status}
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
          title={profile.name}
          heading={<ProfileTitle key={profile.name} profile={profile} onRenamed={reload} />}
          description={profile.builtin ? DESCRIPTION.builtin : DESCRIPTION.custom}
          back={<ListBack />}
          actions={profile.builtin ? undefined : <DeleteProfile profile={profile} />}
        />
      }
    >
      <div className="space-y-4">
        <ProfileGitHub profile={profile} onChanged={reload} />
        <ProfileAws
          key={`${profile.id}:${profile.aws.updated_at ?? ''}`}
          profile={profile}
          hostRole={overview.host_role}
          onChanged={reload}
        />
        <ProfileConnections profile={profile} onChanged={reload} />
        <ProfileSshHosts profile={profile} onChanged={reload} />
        <ProfileAgents profile={profile} />
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Check className="size-3 shrink-0" />
          Saved values are never shown again; changes restart the agents using them at their next turn.
        </p>
      </div>
    </SettingsBody>
  )
}
