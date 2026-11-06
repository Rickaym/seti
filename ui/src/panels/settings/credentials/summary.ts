import { profileInput, type CredentialProfile } from '@seti/shared'
import { toast } from 'sonner'

const count = (n: number, noun: string) => `${String(n)} ${noun}${n === 1 ? '' : 's'}`

export interface ProfileFacts {
  github: string
  aws: string
  connections: string
  agents: string
  ssh: string
}

function githubFact({ github }: CredentialProfile): string {
  const tokens = [...(github.default.configured ? ['Default token'] : []), ...github.owners.map((token) => token.owner)]
  return tokens.length === 0 ? 'No tokens' : tokens.join(', ')
}

function awsFact({ aws }: CredentialProfile): string {
  if (aws.role_arn === null) {
    return 'No role'
  }
  return aws.role_arn.split('/').pop() ?? aws.role_arn
}

function agentsFact({ agents }: CredentialProfile): string {
  if (agents.length === 0) {
    return 'None'
  }
  const unsandboxed = agents.filter((agent) => !agent.sandbox).length
  return unsandboxed === 0
    ? count(agents.length, 'agent')
    : `${count(agents.length, 'agent')}, ${String(unsandboxed)} unsandboxed`
}

/** What a profile covers at a glance, for its row in the list. */
export const profileFacts = (profile: CredentialProfile): ProfileFacts => ({
  github: githubFact(profile),
  aws: awsFact(profile),
  connections: profile.connections.length === 0 ? 'None' : profile.connections.map((entry) => entry.name).join(', '),
  agents: agentsFact(profile),
  ssh: profile.ssh_hosts.length === 0 ? 'None' : profile.ssh_hosts.join(', '),
})

/** The name if it is valid, otherwise null after a toast saying why. */
export function validName(name: string): string | null {
  const parsed = profileInput.safeParse({ name })
  if (!parsed.success) {
    toast.error(parsed.error.issues[0]?.message ?? 'Check the name')
    return null
  }
  return parsed.data.name
}
