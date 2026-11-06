import fs from 'node:fs'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import type { FileShare, Share, ShareLink, ShareList, ShareScanRefusal } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { asAgent } from './access.js'
import { createApp } from './app.js'
import { SETI_HOME } from './config.js'
import { sql, tasks } from './db.js'
import { createShare, setSharing } from './shares.js'
import { auditEvents } from './store/audit.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { workspaceDir } from './workspace/dir.js'

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof Sdk>()),
  query: (_params: { prompt: unknown; options?: Options }) => {
    const session = (async function* () {
      await Promise.resolve()
      yield* []
    })()
    return Object.assign(session, { close: () => undefined })
  },
}))

const scratch = fs.mkdtempSync(path.join(path.dirname(SETI_HOME), 'shares-'))
const cwd = path.join(scratch, 'agent')
const other = path.join(scratch, 'other')
const outside = path.join(scratch, 'outside')

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

const app = createApp()
const BASE = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006' }
const USER = { ...BASE, ...USER_AUTH }
const EA = { ...BASE, ...EA_AUTH }
const TASK = 'share-task'
const OTHER = 'share-other'
const GH_TOKEN = `ghp_${'a1B2c3D4'.repeat(5)}`

async function send(headers: Record<string, string>, method: string, url: string, body?: unknown) {
  return app.request(`/api${url}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function data<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { data: T }).data
}

async function refused(res: Response, status: number): Promise<string> {
  expect(res.status, await res.clone().text()).toBe(status)
  return ((await res.json()) as { error: { detail: string } }).error.detail
}

const write = (file: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

const create = async (file: string, extra: Record<string, unknown> = {}, task = TASK) =>
  send(USER, 'POST', `/tasks/${task}/shares`, { root: 'cwd', path: file, ...extra })

const tokenOf = (link: ShareLink) => link.url.slice(link.url.lastIndexOf('/') + 1)

const open = async (token: string, suffix = '') =>
  app.request(`/share/${token}${suffix}`, { headers: { host: '127.0.0.1:3006' } })

beforeAll(async () => {
  write(path.join(cwd, 'notes.md'), '# Notes\n')
  write(path.join(cwd, 'report.txt'), 'version one\n')
  write(path.join(cwd, 'leaky.txt'), `first\nsecond\ntoken ${GH_TOKEN}\n`)
  write(path.join(cwd, 'config', 'prod.env'), 'A=1\n')
  write(path.join(cwd, 'certs', 'server.pem'), 'pem\n')
  write(path.join(cwd, 'keys', 'id_ed25519'), 'key\n')
  write(path.join(cwd, 'credentials.json'), '{}\n')
  write(path.join(cwd, 'android', 'keystore.properties'), 'storePassword=x\n')
  write(path.join(cwd, 'android', 'app.jks'), 'jks\n')
  write(path.join(cwd, 'firebase-sa.json'), '{}\n')
  write(path.join(cwd, 'docker', '.docker', 'config.json'), '{}\n')
  write(path.join(cwd, 'big.bin'), Buffer.alloc(10 * 1024 * 1024 + 1))
  write(path.join(outside, 'escape.txt'), 'outside\n')
  write(path.join(other, 'theirs.txt'), 'theirs\n')
  fs.symlinkSync(path.join(outside, 'escape.txt'), path.join(cwd, 'escape.txt'))
  fs.symlinkSync(path.join(cwd, 'report.txt'), path.join(cwd, 'alias.txt'))
  write(path.join(workspaceDir(TASK), 'summary.md'), '# Summary\n')
  write(path.join(SETI_HOME, 'credentials-like', 'secret.txt'), 'seti data\n')
  fs.symlinkSync(path.join(SETI_HOME, 'credentials-like', 'secret.txt'), path.join(workspaceDir(TASK), 'seti.txt'))
  fs.symlinkSync(path.join(other, 'theirs.txt'), path.join(workspaceDir(TASK), 'theirs.txt'))
  await tasks.insert({ id: TASK, title: 'Sharer', repo_id: null, cwd, worktree: false, pr_urls: [] })
  await tasks.insert({ id: OTHER, title: 'Other', repo_id: null, cwd: other, worktree: false, pr_urls: [] })
  await sql`INSERT INTO task_dir (task_id, dir) VALUES (${OTHER}, ${outside})`
})

describe('the Sharing switch', () => {
  it('starts off, refuses new shares while off, and only the user turns it on', async () => {
    expect((await data<ShareList>(await send(USER, 'GET', '/shares'))).enabled).toBe(false)
    expect(await refused(await create('notes.md'), 403)).toContain('Sharing is off')
    expect(await refused(await send(EA, 'PUT', '/shares/settings', { enabled: true }), 403)).toBe(
      'The EA cannot share files outside Seti; the user does that in Seti',
    )
    expect((await data<ShareList>(await send(USER, 'PUT', '/shares/settings', { enabled: true }))).enabled).toBe(true)
    expect(await auditEvents.latest('system.sharing_changed')).toMatchObject({ detail: { enabled: true } })
  })
})

describe('who shares', () => {
  it('refuses the EA every share route, reads included', async () => {
    const what = 'The EA cannot share files outside Seti; the user does that in Seti'
    expect(await refused(await send(EA, 'GET', '/shares'), 403)).toBe(what)
    expect(await refused(await send(EA, 'POST', `/tasks/${TASK}/shares`, { root: 'cwd', path: 'notes.md' }), 403)).toBe(
      what,
    )
    expect(await refused(await send(EA, 'GET', `/tasks/${TASK}/shares?root=cwd&path=notes.md`), 403)).toBe(what)
    expect(await refused(await send(EA, 'POST', '/shares/revoke-all', {}), 403)).toBe(what)
    expect(await refused(await send(EA, 'POST', '/shares/x/rotate', {}), 403)).toBe(what)
    expect(await refused(await send(EA, 'POST', '/shares/x/update', {}), 403)).toBe(what)
    expect(await refused(await send(EA, 'DELETE', '/shares/x'), 403)).toBe(what)
  })

  it("refuses an agent's seti tools, through the API and the service alike", async () => {
    const agent = { id: OTHER, title: 'Other', seti_control: 'full' as const }
    const res = await asAgent(agent, async () =>
      send(BASE, 'POST', `/tasks/${TASK}/shares`, { root: 'cwd', path: 'x' }),
    )
    expect(await refused(res, 403)).toBe('Only the user shares files outside Seti')
    const list = await asAgent(agent, async () => send(BASE, 'GET', '/shares'))
    expect(await refused(list, 403)).toBe('Only the user shares files outside Seti')
    const input = {
      root: 'cwd',
      path: 'notes.md',
      expires_in_days: 7 as const,
      allow_findings: false,
      link_preview: true,
    }
    await expect(asAgent(agent, async () => createShare(TASK, input, 'https://x.test'))).rejects.toThrow(
      'Agents cannot share files outside Seti',
    )
    await expect(asAgent(agent, async () => setSharing(false))).rejects.toThrow('Agents cannot change sharing')
  })

  it('refuses requests without a credential', async () => {
    expect((await send(BASE, 'GET', '/shares')).status).toBe(401)
  })
})

describe('what a share may hold', () => {
  it('refuses paths that leave the root, by .. or a symlink, and absolute paths', async () => {
    expect(await refused(await create('../outside/escape.txt'), 403)).toContain('leads outside its root')
    expect(await refused(await create('escape.txt'), 403)).toContain('leads outside its root')
    expect((await create('/etc/passwd')).status).toBe(400)
    expect((await create('missing.txt')).status).toBe(404)
  })

  it('refuses keys, credentials, env files, signing material and dot paths', async () => {
    for (const file of [
      'config/prod.env',
      'certs/server.pem',
      'keys/id_ed25519',
      'credentials.json',
      'android/keystore.properties',
      'android/app.jks',
      'firebase-sa.json',
      'docker/.docker/config.json',
      '.env',
      '.git/config',
    ]) {
      expect((await create(file)).status, file).toBe(403)
    }
  })

  it('refuses folders and files over 10 MB', async () => {
    expect(await refused(await create('config'), 400)).toContain('is a folder')
    expect(await refused(await create('big.bin'), 413)).toContain('10 MB')
  })

  it("refuses another agent's paths and Seti's own data, and shares from the agent's workspace", async () => {
    const roots = await data<{ id: string }[]>(await send(USER, 'GET', `/tasks/${OTHER}/files/roots`))
    const outsideRoot = roots.find((root) => root.id.startsWith('dir-'))?.id ?? ''
    expect((await create('escape.txt', { root: outsideRoot })).status).toBe(404)
    const inWorkspace = { root: 'workspace' }
    expect(await refused(await create('seti.txt', inWorkspace), 403)).toContain('leads outside its root')
    expect(await refused(await create('theirs.txt', inWorkspace), 403)).toContain('leads outside its root')
    const link = await data<ShareLink>(await create('summary.md', inWorkspace))
    expect(link.share.path).toBe('summary.md')
    await data(await send(USER, 'DELETE', `/shares/${link.share.id}`))
  })

  it('names the lines and kinds of secrets without their values, and shares anyway when allowed', async () => {
    const res = await create('leaky.txt')
    const text = await res.clone().text()
    expect(res.status).toBe(409)
    expect(text).not.toContain(GH_TOKEN)
    expect(((await res.json()) as ShareScanRefusal).findings).toEqual([{ line: 3, kind: 'access token' }])
    const link = await data<ShareLink>(await create('leaky.txt', { allow_findings: true }))
    expect(link.share.scan_override).toBe(true)
    expect(await auditEvents.latest('task.file_shared')).toMatchObject({ detail: { scan_override: true } })
    await data(await send(USER, 'DELETE', `/shares/${link.share.id}`))
  })

  it('validates bodies', async () => {
    expect((await create('notes.md', { expires_in_days: 3 })).status).toBe(400)
    expect((await create('notes.md', { extra: true })).status).toBe(400)
    expect((await send(USER, 'POST', '/shares/revoke-all', { all: true })).status).toBe(400)
  })
})

describe('a share', () => {
  it('opens once per file, shows its link once, and finds it by path without the token', async () => {
    const link = await data<ShareLink>(await create('report.txt', { expires_in_days: 1 }))
    expect(link.url).toMatch(/^http:\/\/127\.0\.0\.1:3006\/share\/[A-Za-z0-9_-]{43}$/)
    const days = (Date.parse(link.share.expires_at) - Date.parse(link.share.created_at)) / 86_400_000
    expect(days).toBe(1)
    expect(await refused(await create('report.txt'), 409)).toContain('already shared')
    const found = await data<FileShare>(await send(USER, 'GET', `/tasks/${TASK}/shares?root=cwd&path=report.txt`))
    expect(found.share?.id).toBe(link.share.id)
    const listed = await send(USER, 'GET', '/shares')
    expect(await listed.clone().text()).not.toContain(tokenOf(link))
    const stored = await sql<{ token_hash: string }[]>`SELECT token_hash FROM share WHERE id = ${link.share.id}`
    expect(stored[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(stored)).not.toContain(tokenOf(link))
    await data(await send(USER, 'DELETE', `/shares/${link.share.id}`))
  })

  it('updates to the content now under the same link, rotates to a new link, and revokes', async () => {
    write(path.join(cwd, 'report.txt'), 'version one\n')
    const link = await data<ShareLink>(await create('report.txt'))
    const token = tokenOf(link)
    expect(await (await open(token, '/raw')).text()).toBe('version one\n')

    write(path.join(cwd, 'report.txt'), `version two\n${GH_TOKEN}\n`)
    const scan = await send(USER, 'POST', `/shares/${link.share.id}/update`, {})
    expect(scan.status).toBe(409)
    expect(await (await open(token, '/raw')).text()).toBe('version one\n')
    const updated = await data<Share>(
      await send(USER, 'POST', `/shares/${link.share.id}/update`, { allow_findings: true }),
    )
    expect(updated.version).toBe(2)
    expect(await (await open(token, '/raw')).text()).toBe(`version two\n${GH_TOKEN}\n`)
    expect(await auditEvents.latest('task.share_updated')).toMatchObject({ subject_id: TASK })

    const rotated = await data<ShareLink>(await send(USER, 'POST', `/shares/${link.share.id}/rotate`, {}))
    expect(tokenOf(rotated)).not.toBe(token)
    expect((await open(token)).status).toBe(404)
    expect((await open(tokenOf(rotated))).status).toBe(200)
    expect(await auditEvents.latest('task.share_link_rotated')).toMatchObject({ subject_id: TASK })

    const revoked = await data<Share>(await send(USER, 'DELETE', `/shares/${link.share.id}`))
    expect(revoked.revoked_at).not.toBeNull()
    expect((await open(tokenOf(rotated))).status).toBe(404)
    expect(await sql`SELECT 1 FROM share_blob WHERE share_id = ${revoked.id}`).toHaveLength(0)
    expect((await send(USER, 'POST', `/shares/${link.share.id}/update`, {})).status).toBe(404)
    expect((await send(USER, 'POST', `/shares/${link.share.id}/rotate`, {})).status).toBe(404)
    expect(await auditEvents.latest('task.share_revoked')).toMatchObject({ subject_id: TASK })
    write(path.join(cwd, 'report.txt'), 'version one\n')
  })

  it('refuses an update once the path leads to another file', async () => {
    const link = await data<ShareLink>(await create('alias.txt'))
    fs.rmSync(path.join(cwd, 'alias.txt'))
    fs.symlinkSync(path.join(cwd, 'notes.md'), path.join(cwd, 'alias.txt'))
    expect(await refused(await send(USER, 'POST', `/shares/${link.share.id}/update`, {}), 409)).toContain(
      'another file',
    )
    await data(await send(USER, 'DELETE', `/shares/${link.share.id}`))
  })

  it('stops at its expiry and drops its copy', async () => {
    const link = await data<ShareLink>(await create('notes.md'))
    expect((await open(tokenOf(link))).status).toBe(200)
    await sql`UPDATE share SET expires_at = ${new Date(Date.now() - 1000).toISOString()} WHERE id = ${link.share.id}`
    expect((await open(tokenOf(link))).status).toBe(404)
    expect((await send(USER, 'POST', `/shares/${link.share.id}/update`, {})).status).toBe(404)
    const list = await data<ShareList>(await send(USER, 'GET', '/shares'))
    expect(list.shares.find((share) => share.id === link.share.id)?.size).toBe(0)
    const found = await data<FileShare>(await send(USER, 'GET', `/tasks/${TASK}/shares?root=cwd&path=notes.md`))
    expect(found.share).toBeNull()
  })

  it('revokes every share at once', async () => {
    const first = await data<ShareLink>(await create('notes.md'))
    const second = await data<ShareLink>(await create('summary.md', { root: 'workspace' }))
    expect((await data<{ revoked: number }>(await send(USER, 'POST', '/shares/revoke-all', {}))).revoked).toBe(2)
    expect((await open(tokenOf(first))).status).toBe(404)
    expect((await open(tokenOf(second))).status).toBe(404)
    expect(await auditEvents.latest('system.shares_revoked')).toMatchObject({ detail: { count: 2 } })
  })

  it('goes away with its agent', async () => {
    await tasks.insert({ id: 'share-gone', title: 'Gone', repo_id: null, cwd, worktree: false, pr_urls: [] })
    const link = await data<ShareLink>(await create('notes.md', {}, 'share-gone'))
    await tasks.remove('share-gone')
    expect((await open(tokenOf(link))).status).toBe(404)
    expect(await sql`SELECT 1 FROM share WHERE id = ${link.share.id}`).toHaveLength(0)
  })
})
