import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_GITHUB_TOKEN,
  DEFAULT_PROFILE_ID,
  isGitHubOwner,
  type GitHubTokenMode,
  type StoredSecretName,
} from '@seti/shared'
import { SETI_HOME } from './config.js'
import { githubTokens, secret, secrets } from './secrets.js'

/** The env file that held the agent token before the secret store; imported once at startup. */
const LEGACY_AGENT_TOKEN_FILE = path.join(SETI_HOME, 'agent.env')

const ASSIGNMENT = /^(?:export\s+)?GH_TOKEN\s*=(.*)$/

const unquote = (value: string) => value.replace(/^(["'])(.*)\1$/, '$2')

/** GH_TOKEN from an env file, or null when the file or the variable is missing or empty. */
export function readTokenFile(file: string): string | null {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const value = text
    .split('\n')
    .map((line) => ASSIGNMENT.exec(line.trim())?.[1])
    .findLast((match) => match !== undefined)
  const token = value === undefined ? '' : unquote(value.trim())
  return token === '' ? null : token
}

/** Moves GH_TOKEN from agent.env into the secret store when the store has no agent token yet. */
export async function importAgentTokenFile(file: string = LEGACY_AGENT_TOKEN_FILE): Promise<void> {
  const token = readTokenFile(file)
  if (token !== null && (await secrets.importOnce(DEFAULT_GITHUB_TOKEN, token, file))) {
    process.stderr.write(`secrets: imported GH_TOKEN from ${file}; delete that file once Seti works without it\n`)
  }
}

/** Changes when a profile's GitHub token is set or cleared, so its sessions restart. */
export const agentTokenStamp = async (profileId: string = DEFAULT_PROFILE_ID) => githubTokens(profileId).stamp()

async function openToken(name: StoredSecretName): Promise<string | null> {
  try {
    return await secret(name)
  } catch (e) {
    process.stderr.write(`sandbox: ${e instanceof Error ? e.message : String(e)}\n`)
    return null
  }
}

/**
 * The fine-grained token the egress proxy puts on sandboxed agents' GitHub requests, never the gh
 * login's: the profile's token for the owner when it has one, else its default; null when neither
 * opens. A profile never falls back to another profile's tokens.
 */
export async function agentToken(profileId: string, owner: string | null = null): Promise<string | null> {
  const { names } = githubTokens(profileId)
  const own = owner !== null && isGitHubOwner(owner) ? await openToken(names.owner(owner)) : null
  return own ?? openToken(names.token)
}

/** Whether the Default profile has a GitHub token; one that will not open still counts as set. */
export async function githubTokenMode(): Promise<GitHubTokenMode> {
  return (await agentTokenStamp()) === null ? 'none' : 'agent'
}
