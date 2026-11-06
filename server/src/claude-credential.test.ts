import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeCredential, claudeCredentialMode } from './claude-credential.js'
import { CLAUDE_HOME } from './config.js'
import { secrets } from './secrets.js'

const LOGIN = ['sk', 'ant', 'oat01', 'login'].join('-')
const LONG_LIVED = ['sk', 'ant', 'oat01', 'setup'].join('-')
const file = path.join(CLAUDE_HOME, '.credentials.json')
const login = (accessToken: string) => {
  fs.mkdirSync(CLAUDE_HOME, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken } }))
}

describe('claudeCredential', () => {
  afterEach(async () => {
    await secrets.clear('claude_oauth_token')
    fs.rmSync(file, { force: true })
  })

  it('prefers the long-lived token from Secrets', async () => {
    login(LOGIN)
    await secrets.set('claude_oauth_token', LONG_LIVED, 'settings')
    expect(await claudeCredential()).toEqual({ source: 'token', token: LONG_LIVED })
    expect(await claudeCredentialMode()).toBe('token')
  })

  it("falls back to the host login's access token, read on every call", async () => {
    login(LOGIN)
    expect(await claudeCredential()).toEqual({ source: 'login', token: LOGIN })
    expect(await claudeCredentialMode()).toBe('login')
    login('next')
    expect((await claudeCredential())?.token).toBe('next')
  })

  it('is null without a token or a readable login', async () => {
    expect(await claudeCredential()).toBeNull()
    expect(await claudeCredentialMode()).toBe('none')
    fs.mkdirSync(CLAUDE_HOME, { recursive: true })
    fs.writeFileSync(file, '{"mcpOAuth":{}}')
    expect(await claudeCredential()).toBeNull()
    fs.writeFileSync(file, 'not json')
    expect(await claudeCredential()).toBeNull()
  })
})
