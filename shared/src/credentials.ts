import { z } from 'zod'
import { awsSettingsInput, type AwsSettings } from './aws.js'
import type { ProfileConnection } from './connections.js'
import type { GitHubOwnerToken, SecretSource } from './secrets.js'

/** The built-in credentials every task starts with; it holds what Seti had before credentials. */
export const DEFAULT_PROFILE_ID = 'default'

const PROFILE_NAME = /^[\w .-]{1,40}$/

export const profileName = z
  .string()
  .trim()
  .regex(PROFILE_NAME, 'Use 1 to 40 letters, digits, spaces, dots, hyphens or underscores')

export const profileInput = z.object({ name: profileName })
export type ProfileInput = z.infer<typeof profileInput>

export const profileParams = z.object({ id: z.string().min(1).max(64) })

export interface ProfileGitHub {
  /** The token for requests that name no owner or an owner without its own. */
  default: { configured: boolean; source: SecretSource | null; updated_at: string | null }
  owners: GitHubOwnerToken[]
}

export interface ProfileAgent {
  id: string
  title: string
  sandbox: boolean
}

/** A credential: the bundle of access an agent picks, with the connections it carries. */
export interface CredentialProfile {
  id: string
  name: string
  builtin: boolean
  aws: AwsSettings
  github: ProfileGitHub
  connections: ProfileConnection[]
  agents: ProfileAgent[]
  /** Aliases of the ssh hosts it bundles: every agent using it gets them. */
  ssh_hosts: string[]
  created_at: string
  updated_at: string
}

export interface CredentialsOverview {
  profiles: CredentialProfile[]
  /** The role this machine runs as, which a role's trust policy names; null when unknown. */
  host_role: string | null
}

/** A credential as anyone may see it, the EA included: its name and how many agents use it. */
export interface ProfileSummary {
  id: string
  name: string
  builtin: boolean
  agents: number
}

export const profileAwsInput = awsSettingsInput
