import fs from 'node:fs'
import type { ClaudeCredentialMode, SecretName } from '@seti/shared'
import { hostLoginKey, loginPaths, savedAccessToken } from './claude-logins.js'
import { secret, secretStamp } from './secrets.js'

const CLAUDE_TOKEN: SecretName = 'claude_oauth_token'

export interface ClaudeCredential {
  source: Exclude<ClaudeCredentialMode, 'none'>
  token: string
}

/** The scope an OAuth token needs to list and reach claude.ai connectors. */
export const CONNECTOR_SCOPE = 'user:mcp_servers'

interface HostLogin {
  accessToken: string
  scopes: string[]
}

/** The host's Claude Code login: its OAuth access token and scopes, or null when there is none. */
function hostLogin(file: string): HostLogin | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || !('claudeAiOauth' in parsed)) {
    return null
  }
  const oauth = parsed.claudeAiOauth
  if (typeof oauth !== 'object' || oauth === null || !('accessToken' in oauth)) {
    return null
  }
  if (typeof oauth.accessToken !== 'string' || oauth.accessToken === '') {
    return null
  }
  const scopes = 'scopes' in oauth && Array.isArray(oauth.scopes) ? oauth.scopes.map(String) : []
  return { accessToken: oauth.accessToken, scopes }
}

const loginFile = () => loginPaths().credentials

const loginAccessToken = (file: string) => hostLogin(file)?.accessToken ?? null

/**
 * The host login's token for claude.ai connectors, or null when it lacks their scope. A
 * long-lived setup-token token is inference-only, so connectors always use the host login.
 */
export function connectorCredential(file: string = loginFile()): string | null {
  const login = hostLogin(file)
  return login?.scopes.includes(CONNECTOR_SCOPE) === true ? login.accessToken : null
}

async function storedToken(): Promise<string | null> {
  try {
    return await secret(CLAUDE_TOKEN)
  } catch (e) {
    process.stderr.write(`sandbox: ${e instanceof Error ? e.message : String(e)}\n`)
    return null
  }
}

/**
 * The credential the egress proxy puts on sandboxed agents' Claude API requests: the long-lived
 * token from Secrets when set, else the host login, read on every call so a refresh by another
 * Claude Code process is picked up. A session that started on another saved login keeps that
 * login's token until it restarts, so a switch never moves a running turn to another account.
 */
export async function claudeCredential(startedOn?: string | null): Promise<ClaudeCredential | null> {
  const stored = await storedToken()
  if (stored !== null) {
    return { source: 'token', token: stored }
  }
  if (startedOn === undefined || startedOn === null || startedOn === hostLoginKey()) {
    const token = loginAccessToken(loginFile())
    return token === null ? null : { source: 'login', token }
  }
  const pinned = await savedAccessToken(startedOn)
  return pinned === null ? null : { source: 'login', token: pinned }
}

/** Where the credential comes from; a stored token that will not open still counts as set. */
export async function claudeCredentialMode(): Promise<ClaudeCredentialMode> {
  if ((await secretStamp(CLAUDE_TOKEN)) !== null) {
    return 'token'
  }
  return loginAccessToken(loginFile()) === null ? 'none' : 'login'
}
