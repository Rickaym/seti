import { z } from 'zod'
import type { AccessKind } from './access.js'
import { awsSettingsInput, type AwsSettings } from './aws.js'
import type { ProfileConnection } from './connections.js'
import { domainEntry } from './sandbox.js'
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

/** One entry of a credential's access set: what its agents get unless they chose their own. */
export interface CredentialAccessEntry {
  kind: AccessKind
  id: string
  enabled: boolean
}

/** What a credential's agents follow; an item it does not name has no opinion. */
export interface CredentialAccessSet {
  items: CredentialAccessEntry[]
  /** Hosts its agents reach beside the shared allowlist and their own. */
  hosts: string[]
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
  /** Aliases of the ssh hosts its access set turns on. */
  ssh_hosts: string[]
  access: CredentialAccessSet
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

/** A host every agent using the credential reaches beside the shared allowlist. */
export const credentialHostInput = z.object({ host: domainEntry })

export const credentialHostParams = z.object({ id: z.string().min(1).max(64), host: domainEntry })

/** Asks what saving an agent's access into its credential would change. */
export const accessPreviewInput = z.object({ task_id: z.string().min(1).max(64) })

/** Saves an agent's access into its credential; `expect` is the fingerprint of the preview read. */
export const accessSaveInput = accessPreviewInput.extend({ expect: z.string().regex(/^[0-9a-f]{64}$/) })
export type AccessSaveInput = z.input<typeof accessSaveInput>

/** One item a save changes in the credential, and which other agents it changes. */
export interface AccessSaveChange {
  kind: AccessKind
  id: string
  name: string
  enabled: boolean
  /** The credential's value before; null when it had no opinion. */
  was: boolean | null
  /** Other agents on the credential whose state turns to `enabled`. */
  turns: string[]
  /** Other agents that keep their own choice on it. */
  keeps: string[]
}

/** What saving an agent's access into its credential would change, read before the user saves. */
export interface AccessSavePreview {
  profile: { id: string; name: string }
  /** The other agents using the credential, which follow it from their next turn. */
  agents: string[]
  /** SSH and AWS first. */
  changes: AccessSaveChange[]
  hosts_added: string[]
  /** The saving agent's own choices and hosts, cleared since the credential now gives them. */
  own_cleared: number
  own_hosts_cleared: number
  fingerprint: string
}
