import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createSignIns } from './claude-sign-in.js'
import { sql } from './db.js'
import { secretRows } from './store/secrets.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-sign-in-'))
const ACCESS = ['fake', 'signin', 'access', 'Qw7r'].join('-')
const GOOD = ['code', 'Zx91', 'state'].join('#')

/** Stands in for `claude auth login`: prints a sign-in link, then takes one good code. */
const FAKE_CLAUDE = `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const dir = process.env.CLAUDE_CONFIG_DIR
const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y'
process.stdout.write('Opening browser to sign in\\n')
process.stdout.write('If the browser did not open, visit: \\u001b]8;;' + url + '\\u0007' + url + '\\u001b]8;;\\u0007\\n')
process.stdout.write('Paste code here if prompted > ')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\\n')
  buffer = lines.pop()
  for (const line of lines) {
    if (line !== ${JSON.stringify(GOOD)}) {
      process.stdout.write('Invalid code. Please make sure the full code was copied.\\n')
      continue
    }
    const oauth = { accessToken: ${JSON.stringify(ACCESS)}, refreshToken: 'r', subscriptionType: 'pro' }
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }))
    const account = { accountUuid: 'uuid-new', organizationUuid: 'org-new', emailAddress: 'new@example.test' }
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: account }))
    process.stdout.write('Login successful.\\n')
    process.exit(0)
  }
})
`

const bin = path.join(root, 'claude')
fs.writeFileSync(bin, FAKE_CLAUDE, { mode: 0o755 })
const signIns = createSignIns({ bin, root: path.join(root, 'logins') })

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

beforeEach(async () => {
  await sql`DELETE FROM claude_login`
})

describe('signing in to another Claude account from Seti', () => {
  it('hands out the sign-in page, retries a refused code, and saves the login without its token', async () => {
    const started = await signIns.start('Personal')
    expect(started.url).toBe('https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y')
    await expect(signIns.finish(started.id, 'wrong-code-1234')).rejects.toThrow('did not accept that code')
    const { login, created } = await signIns.finish(started.id, GOOD)
    expect(created).toBe(true)
    expect(login).toMatchObject({ name: 'Personal', email: 'new@example.test', plan: 'pro' })
    expect(JSON.stringify(login)).not.toContain(ACCESS)
    const [row] = await secretRows.withPrefix('claude_login:')
    expect(row?.sealed).not.toContain(ACCESS)
    expect(fs.readdirSync(path.join(root, 'logins'))).toEqual([])
    expect(signIns.open()).toBe(0)
  })

  it('updates the saved login with the same account instead of adding a second one', async () => {
    const first = await signIns.start('Personal')
    const saved = await signIns.finish(first.id, GOOD)
    const second = await signIns.start('Again')
    const again = await signIns.finish(second.id, GOOD)
    expect(again).toEqual({ login: { ...saved.login, updated_at: again.login.updated_at }, created: false })
    expect(await sql`SELECT id FROM claude_login`).toHaveLength(1)
  })

  it('cancels a sign-in and removes its directory', async () => {
    const started = await signIns.start('Personal')
    signIns.cancel(started.id)
    expect(fs.readdirSync(path.join(root, 'logins'))).toEqual([])
    await expect(signIns.finish(started.id, GOOD)).rejects.toThrow('has ended')
  })
})
