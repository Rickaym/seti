import fs from 'node:fs'
import path from 'node:path'
import type { APIRequestContext, Page } from '@playwright/test'
import type { AccountStatus, ClaudeLogin } from '@seti/shared'
import { paths } from './env.js'
import { apiData } from './fixtures.js'
import { FAKE_CLAUDE_ENV } from './processes.js'

const BLACKHOLE = 'http://127.0.0.1:9'

/**
 * The fake agent SDK, and a proxy nowhere so the real Claude Code that probes the account never
 * sends the fake tokens anywhere or marks them dead.
 */
export const LOGINS_ENV = {
  ...FAKE_CLAUDE_ENV,
  HTTPS_PROXY: BLACKHOLE,
  HTTP_PROXY: BLACKHOLE,
  NO_PROXY: '127.0.0.1,localhost',
}

/** Fake tokens, built from parts so no scanner takes them for real ones. */
export const fakeToken = (who: string, kind: string) => ['e2e', who, kind, 'Vb3k'].join('-')

const credentialsFile = () => path.join(paths.claudeHome, '.credentials.json')
const configFile = () => path.join(paths.home, '.claude.json')

const readJson = (file: string): Record<string, unknown> =>
  fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>) : {}

const profileOf = (who: string) => ({
  accountUuid: `uuid-${who}`,
  organizationUuid: `org-${who}`,
  emailAddress: `${who}@e2e.invalid`,
  organizationName: `${who} org`,
})

const ACCESS = /^e2e-(\w+)-access-Vb3k$/
const PROFILE_CHECK_MS = 100

/**
 * The account probe's real Claude Code cannot reach Anthropic with fake tokens and writes its
 * config back without the profile; a signed-in machine keeps it, so this puts it back.
 */
function keepProfile(): void {
  const who = ACCESS.exec(String(hostAccessToken()))?.[1]
  const config = readJson(configFile())
  if (who !== undefined && config.oauthAccount === undefined) {
    fs.writeFileSync(configFile(), JSON.stringify({ ...config, oauthAccount: profileOf(who) }, null, 2))
  }
}

let keeper: NodeJS.Timeout | undefined

/** Signs Claude Code in as `who`, as /login in a terminal does: tokens, then the profile. */
export function signInAs(who: string): void {
  keeper ??= setInterval(keepProfile, PROFILE_CHECK_MS).unref()
  fs.mkdirSync(paths.claudeHome, { recursive: true })
  const oauth = {
    accessToken: fakeToken(who, 'access'),
    refreshToken: fakeToken(who, 'refresh'),
    expiresAt: Date.now() + 8 * 3_600_000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
  }
  fs.writeFileSync(credentialsFile(), JSON.stringify({ ...readJson(credentialsFile()), claudeAiOauth: oauth }), {
    mode: 0o600,
  })
  fs.writeFileSync(configFile(), JSON.stringify({ ...readJson(configFile()), oauthAccount: profileOf(who) }, null, 2))
}

/** The access token Claude Code would use now. */
export function hostAccessToken(): unknown {
  const oauth = readJson(credentialsFile()).claudeAiOauth
  return typeof oauth === 'object' && oauth !== null && 'accessToken' in oauth ? oauth.accessToken : null
}

export const savedLogins = async (request: APIRequestContext) =>
  (await apiData<AccountStatus>(request, '/account')).logins

const SAVE_TRIES = 5

/**
 * Signs in as `who` and saves that login under `name` through the API. The account probe's
 * Claude Code may rewrite its config without the fake profile, so a save that finds none retries.
 */
export async function saveLogin(request: APIRequestContext, who: string, name: string): Promise<ClaudeLogin> {
  let failure = ''
  for (let attempt = 0; attempt < SAVE_TRIES; attempt += 1) {
    signInAs(who)
    const response = await request.post('/api/account/logins', { data: { name } })
    if (response.ok()) {
      return ((await response.json()) as { data: ClaudeLogin }).data
    }
    failure = `${String(response.status())} ${await response.text()}`
  }
  throw new Error(`Saving ${name} failed: ${failure}`)
}

export const accountItem = (page: Page) =>
  page.getByRole('contentinfo').getByRole('button', { name: /^Claude account/ })

export const activeLoginName = (page: Page) => page.getByRole('contentinfo').getByTestId('active-login')
