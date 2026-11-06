import { z } from 'zod'

/** Secrets the user manages in Settings; Seti stores them encrypted and never sends them back. */
export const SECRET_NAMES = ['claude_oauth_token'] as const
export type SecretName = (typeof SECRET_NAMES)[number]

export const isSecretName = (value: string): value is SecretName => (SECRET_NAMES as readonly string[]).includes(value)

interface SecretInfo {
  label: string
  /** The variable name the value is known by outside Seti. */
  env: string
  description: string
  placeholder: string
}

export const SECRET_INFO: Record<SecretName, SecretInfo> = {
  claude_oauth_token: {
    label: 'Claude token',
    env: 'SETI_CLAUDE_OAUTH_TOKEN',
    description: 'The long-lived token that claude setup-token prints, for agents to log in to Claude with.',
    placeholder: 'sk-ant-oat01-...',
  },
}

/** Where a stored secret came from: typed into Settings, or imported from an older env file. */
export type SecretSource = 'settings' | 'import'

/** The Default profile's GitHub token, under the name it had before credential profiles. */
export const DEFAULT_GITHUB_TOKEN = 'github_agent_token'

/** Fine-grained GitHub tokens reach one resource owner each, so agents can hold one per owner. */
export const GITHUB_OWNER_TOKEN_PREFIX = 'github_agent_token:'
export type GitHubOwnerSecretName = `${typeof GITHUB_OWNER_TOKEN_PREFIX}${string}`

/** GitHub tokens of a credential profile other than Default. */
export type ProfileSecretName = `profile:${string}`

/** Where a profile keeps its GitHub tokens; Default keeps the names they had before profiles. */
export function githubSecretNames(profileId: string): {
  token: typeof DEFAULT_GITHUB_TOKEN | ProfileSecretName
  ownerPrefix: string
  owner: (owner: string) => GitHubOwnerSecretName | ProfileSecretName
} {
  if (profileId === 'default') {
    return { token: DEFAULT_GITHUB_TOKEN, ownerPrefix: GITHUB_OWNER_TOKEN_PREFIX, owner: githubOwnerSecret }
  }
  const token: ProfileSecretName = `profile:${profileId}:github_agent_token`
  return { token, ownerPrefix: `${token}:`, owner: (owner) => `${token}:${owner.toLowerCase()}` }
}

/** Private keys of Seti's ssh-agent, by key id. */
export type SshKeySecretName = `ssh_key:${string}`

/** Values of secrets users named before connections; connections that took them over read them. */
export const NAMED_SECRET_PREFIX = 'named:'
export type NamedSecretName = `${typeof NAMED_SECRET_PREFIX}${string}`

/** A value a connection holds, by connection id and slot. */
export type ConnectionSecretName = `connection:${string}:${string}`

/** The sealed Claude Code login of a saved Claude account, by account id. */
export type ClaudeLoginSecretName = `claude_login:${string}`

/** The key pair Seti signs push notifications with, as JSON; Seti makes it on first start. */
export const VAPID_KEYS_SECRET = 'vapid_keys'

/** Every name the secret store keeps a value under. */
export type StoredSecretName =
  | SecretName
  | typeof VAPID_KEYS_SECRET
  | typeof DEFAULT_GITHUB_TOKEN
  | GitHubOwnerSecretName
  | SshKeySecretName
  | ProfileSecretName
  | NamedSecretName
  | ConnectionSecretName
  | ClaudeLoginSecretName

/** GitHub's rule for user and organization names: 39 characters, single inner hyphens. */
const GITHUB_OWNER = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/

export const isGitHubOwner = (value: string) => GITHUB_OWNER.test(value.toLowerCase())

export const githubOwnerName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(GITHUB_OWNER, 'Use a GitHub user or organization name, such as octo-org')

export const githubOwnerSecret = (owner: string): GitHubOwnerSecretName =>
  `${GITHUB_OWNER_TOKEN_PREFIX}${owner.toLowerCase()}`

/** A GitHub token kept for one owner: which owner and when it was set, never its value. */
export interface GitHubOwnerToken {
  owner: string
  source: SecretSource
  updated_at: string
}

/** What the API says about a secret: whether it is set and when, never its value. */
export interface SecretStatus {
  name: SecretName
  configured: boolean
  source: SecretSource | null
  updated_at: string | null
}

const SECRET_MAX = 4096

export const secretSetInput = z.object({
  value: z
    .string()
    .trim()
    .min(8, 'Paste the whole token')
    .max(SECRET_MAX)
    .regex(/^[\x21-\x7E]+$/, 'Tokens are printable ASCII with no spaces'),
})
export type SecretSetInput = z.input<typeof secretSetInput>

/** Whether this browser must sign in with the local token before it can use the API. */
export interface LocalSession {
  required: boolean
}

export const localSessionInput = z.object({ token: z.string().trim().min(1).max(512) })
export type LocalSessionInput = z.input<typeof localSessionInput>

/** Where the local sign-in token lives on a systemd install; the sign-in page names it. */
export const LOCAL_TOKEN_FILE = '~/.seti/credentials/local-token-user'
