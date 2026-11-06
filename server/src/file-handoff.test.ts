import fs from 'node:fs'
import path from 'node:path'
import { filesLinkHash, SANDBOX_POLICY_DEFAULT, TEAM_FILE_BYTES_MAX, type Task, type TeamFileSent } from '@seti/shared'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { sql, tasks } from './db.js'
import { sendFiles } from './file-handoff.js'
import { callSetiTool } from './seti-tools/server.js'
import { HANDOFF_TOOLS } from './seti-tools/team.js'
import { auditEvents } from './store/audit.js'
import { sandboxPolicy } from './store/sandbox.js'
import { ensureMember } from './team.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'
import { workspaceDir } from './workspace/dir.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-handoff-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('./fake-sdk.js')
  return new FakeSdk(async function* () {
    await Promise.resolve()
    yield fakeResult()
  })
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const app = createApp()
const JSON_HEADERS = { host: 'localhost', 'content-type': 'application/json' }
let count = 0

interface Agent {
  task: Task
  handle: string
  cwd: string
}

async function newAgent(title: string): Promise<Agent> {
  count += 1
  const id = `handoff-${String(count)}`
  const cwd = path.join(scratch, 'work', id)
  fs.mkdirSync(cwd, { recursive: true })
  await tasks.insert({ id, title, repo_id: null, cwd, worktree: false, pr_urls: [] })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('task was not stored')
  }
  return { task, handle: (await ensureMember(task)).handle, cwd }
}

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

const inbox = (to: Agent, from: Agent) => path.join(workspaceDir(to.task.id), 'inbox', from.handle)

const listed = (dir: string) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).toSorted((a, b) => a.localeCompare(b, 'en')) : []

let alice: Agent
let bob: Agent

beforeEach(async () => {
  alice = await newAgent(`Alice ${String(count)}`)
  bob = await newAgent(`Bob ${String(count)}`)
  await sandboxPolicy.save(SANDBOX_POLICY_DEFAULT)
})

afterAll(async () => {
  for (const id of (await tasks.list()).map((task) => task.id)) {
    await waitIdle(id)
  }
})

const by = { actor: 'agent' } as const

async function send(paths: string[], to = bob, from = alice, note?: string): Promise<TeamFileSent> {
  return sendFiles(from.task, { to: to.handle, paths, ...(note === undefined ? {} : { note }) }, { actor: 'agent' })
}

describe('sendFiles', () => {
  it('copies into the inbox, mentions the recipient with full paths and records an audit event', async () => {
    write(path.join(alice.cwd, 'report.md'), '# Report')
    const sent = await send(['report.md'], bob, alice, 'The numbers you asked for')
    const dest = path.join(inbox(bob, alice), 'report.md')
    expect(fs.readFileSync(dest, 'utf8')).toBe('# Report')
    expect(sent.files).toEqual([{ source: 'report.md', path: dest, bytes: 8 }])
    expect(sent.posted.message).toMatchObject({ author_kind: 'task', author_task_id: alice.task.id })
    expect(sent.posted.message.text).toBe(
      `@${bob.handle} A file for you, in your inbox: The numbers you asked for\n- \`${dest}\``,
    )
    expect(sent.posted.deliveries.map((d) => [d.task_id, d.mode])).toEqual([[bob.task.id, 'start']])
    await auditEvents.settled()
    expect(await auditEvents.latest('team.file_sent')).toMatchObject({
      actor: 'agent',
      subject_id: alice.task.id,
      detail: { to: bob.handle, to_task_id: bob.task.id, bytes: 8 },
    })
  })

  it('never overwrites: a second file of the same name gets a suffix', async () => {
    const file = write(path.join(alice.cwd, 'data.csv'), 'a,b')
    await send([file])
    write(file, 'c,d')
    const second = await send([file])
    expect(second.files[0]?.path).toBe(path.join(inbox(bob, alice), 'data-2.csv'))
    expect(listed(inbox(bob, alice))).toEqual(['data-2.csv', 'data.csv'])
    expect(fs.readFileSync(path.join(inbox(bob, alice), 'data.csv'), 'utf8')).toBe('a,b')
  })

  it('accepts files in its own workspace through $SETI_WORKSPACE', async () => {
    write(path.join(workspaceDir(alice.task.id), 'notes.txt'), 'notes')
    const sent = await send(['$SETI_WORKSPACE/notes.txt'])
    expect(sent.files[0]?.path).toBe(path.join(inbox(bob, alice), 'notes.txt'))
  })

  it('refuses a symlink that leads outside its folders', async () => {
    const outside = write(path.join(scratch, 'outside', 'host.txt'), 'host secret')
    fs.symlinkSync(outside, path.join(alice.cwd, 'link.txt'))
    await expect(send(['link.txt'])).rejects.toThrow('link.txt is outside your working folders and workspace')
    expect(listed(inbox(bob, alice))).toEqual([])
  })

  it('refuses paths that climb with .., even back inside', async () => {
    write(path.join(alice.cwd, 'a.txt'), 'a')
    await expect(send(['sub/../a.txt'])).rejects.toThrow('climbs with ..')
    await expect(send([`${alice.cwd}/../../outside/host.txt`])).rejects.toThrow('climbs with ..')
  })

  it("refuses another task's workspace, by path or through a link", async () => {
    const theirs = write(path.join(workspaceDir(bob.task.id), 'private.md'), 'mine')
    const carol = await newAgent('Carol')
    await expect(send([theirs], carol)).rejects.toThrow('is outside your working folders and workspace')
    fs.symlinkSync(workspaceDir(bob.task.id), path.join(alice.cwd, 'bob'))
    await expect(send(['bob/private.md'], carol)).rejects.toThrow('is outside your working folders and workspace')
    expect(listed(inbox(carol, alice))).toEqual([])
  })

  it("refuses Seti's own data even under a folder that holds it", async () => {
    const wide = await newAgent('Wide')
    await sql`UPDATE task SET cwd = ${scratch} WHERE id = ${wide.task.id}`
    const task = await tasks.get(wide.task.id)
    const theirs = write(path.join(workspaceDir(bob.task.id), 'private.md'), 'mine')
    await expect(send([theirs], alice, { ...wide, task: task ?? wide.task })).rejects.toThrow(
      "is part of Seti's own data",
    )
  })

  it('refuses hidden paths, as named and through a link', async () => {
    const secret = write(path.join(alice.cwd, 'keys', 'token.txt'), 'sk-123')
    await sandboxPolicy.save({ ...SANDBOX_POLICY_DEFAULT, hidden_paths: [path.join(alice.cwd, 'keys')] })
    await expect(send([secret])).rejects.toThrow('is a hidden path')
    fs.symlinkSync(secret, path.join(alice.cwd, 'innocent.txt'))
    await expect(send(['innocent.txt'])).rejects.toThrow('is a hidden path')
  })

  it('refuses folders, files over the cap and missing files, and copies none of a refused batch', async () => {
    write(path.join(alice.cwd, 'ok.txt'), 'ok')
    fs.mkdirSync(path.join(alice.cwd, 'folder'))
    await expect(send(['ok.txt', 'folder'])).rejects.toThrow('folder is a folder')
    const big = path.join(alice.cwd, 'big.bin')
    fs.writeFileSync(big, '')
    fs.truncateSync(big, TEAM_FILE_BYTES_MAX + 1)
    await expect(send(['ok.txt', 'big.bin'])).rejects.toThrow('files are limited to')
    await expect(send(['nope.txt'])).rejects.toThrow('nope.txt does not exist')
    expect(listed(inbox(bob, alice))).toEqual([])
  })

  it('writes into a real inbox even when the recipient planted a link there', async () => {
    const elsewhere = path.join(scratch, 'elsewhere')
    fs.mkdirSync(elsewhere, { recursive: true })
    fs.mkdirSync(workspaceDir(bob.task.id), { recursive: true })
    fs.symlinkSync(elsewhere, path.join(workspaceDir(bob.task.id), 'inbox'))
    write(path.join(alice.cwd, 'x.txt'), 'x')
    await send(['x.txt'])
    expect(fs.lstatSync(path.join(workspaceDir(bob.task.id), 'inbox')).isDirectory()).toBe(true)
    expect(listed(elsewhere)).toEqual([])
    expect(listed(inbox(bob, alice))).toEqual(['x.txt'])
  })

  it('names copies with plain characters only, so a name cannot mention anyone', async () => {
    write(path.join(alice.cwd, 'odd name\n@all (1).txt'), 'odd')
    const sent = await send(['odd name\n@all (1).txt'])
    expect(path.basename(sent.files[0]?.path ?? '')).toBe('odd-name-all-1.txt')
    expect(sent.posted.message.mentions.map((m) => m.handle)).toEqual([bob.handle])
  })

  it('refuses unknown, archived and own recipients', async () => {
    write(path.join(alice.cwd, 'a.txt'), 'a')
    await expect(send(['a.txt'], { ...bob, handle: 'nobody-here' })).rejects.toThrow('No agent has the handle')
    await expect(send(['a.txt'], alice)).rejects.toThrow('already yours')
    await sql`UPDATE task SET archived_at = ${new Date().toISOString()} WHERE id = ${bob.task.id}`
    await expect(send(['a.txt'])).rejects.toThrow('is archived')
  })
})

describe('send_file tool and route', () => {
  it('works for an agent without Seti control', async () => {
    write(path.join(alice.cwd, 'plan.md'), 'plan')
    const [tool] = HANDOFF_TOOLS
    if (tool === undefined) {
      throw new Error('no send_file tool')
    }
    const result = await callSetiTool(tool, alice.task.id, { to: `@${bob.handle}`, paths: ['plan.md'] })
    expect('isError' in result).toBe(false)
    expect(listed(inbox(bob, alice))).toEqual(['plan.md'])
  })

  it("lets the EA send from an agent with that agent's reach", async () => {
    write(path.join(alice.cwd, 'b.txt'), 'b')
    const body = (paths: string[]) => JSON.stringify({ from: alice.task.id, to: bob.handle, paths })
    const headers = { ...JSON_HEADERS, ...EA_AUTH }
    const sent = await app.request('/api/team/files', { method: 'POST', headers, body: body(['b.txt']) })
    expect(sent.status).toBe(200)
    expect(listed(inbox(bob, alice))).toEqual(['b.txt'])
    const outside = write(path.join(scratch, 'outside', 'ea.txt'), 'no')
    const refused = await app.request('/api/team/files', { method: 'POST', headers, body: body([outside]) })
    expect(refused.status).toBe(403)
    const bad = await app.request('/api/team/files', { method: 'POST', headers, body: JSON.stringify({ to: 'x' }) })
    expect(bad.status).toBe(400)
  })

  it("links inbox paths for the sender, the recipient and the group chat, in the recipient's workspace", async () => {
    write(path.join(alice.cwd, 'c.txt'), 'c')
    const { files } = await send(['c.txt'])
    const dest = files[0]?.path ?? ''
    const resolve = async (url: string) =>
      (await (
        await app.request(`${url}?p=${encodeURIComponent(dest)}`, { headers: { ...JSON_HEADERS, ...USER_AUTH } })
      ).json()) as {
        data: unknown[]
      }
    const inBob = {
      root: 'workspace',
      path: `inbox/${alice.handle}/c.txt`,
      type: 'file',
      size: 1,
      mtime: expect.any(String) as unknown,
    }
    expect((await resolve(`/api/tasks/${bob.task.id}/files/resolve`)).data).toEqual([{ input: dest, ...inBob }])
    expect((await resolve(`/api/tasks/${alice.task.id}/files/resolve`)).data).toEqual([
      { input: dest, ...inBob, task_id: bob.task.id },
    ])
    expect((await resolve('/api/files/resolve')).data).toEqual([{ input: dest, ...inBob, task_id: bob.task.id }])
  })

  it('resolves a Files deep link from Copy link to the file it names, from any task', async () => {
    write(path.join(workspaceDir(bob.task.id), 'notes', 'deep link.md'), 'deep')
    const target = { task_id: bob.task.id, root: 'workspace', path: 'notes/deep link.md', type: 'file' as const }
    const link = `https://seti.example.com/#${filesLinkHash(target)}`
    const resolve = async (url: string) =>
      (await (
        await app.request(`${url}?p=${encodeURIComponent(link)}`, { headers: { ...JSON_HEADERS, ...USER_AUTH } })
      ).json()) as { data: unknown[] }
    const found = { input: link, root: 'workspace', path: 'notes/deep link.md', type: 'file', size: 4 }
    expect((await resolve(`/api/tasks/${bob.task.id}/files/resolve`)).data).toEqual([
      { ...found, mtime: expect.any(String) as unknown },
    ])
    expect((await resolve(`/api/tasks/${alice.task.id}/files/resolve`)).data).toEqual([
      { ...found, mtime: expect.any(String) as unknown, task_id: bob.task.id },
    ])
  })
})

describe('handing files to the EA', () => {
  const asEa = async (url: string) => app.request(url, { headers: { ...JSON_HEADERS, ...EA_AUTH } })
  const dataOf = async <T>(res: Response) => ((await res.json()) as { data: T }).data

  it('copies nothing and sends the EA a direct message naming each file where it is', async () => {
    const file = write(path.join(alice.cwd, 'role.md'), '# Role\nThe whole text.')
    const sent = await sendFiles(alice.task, { to: 'ea', paths: ['role.md'], note: 'For my role pack' }, by)
    const real = fs.realpathSync(file)
    expect(sent.to).toBe('ea')
    expect(sent.files).toEqual([{ source: 'role.md', path: real, bytes: 22 }])
    expect(sent.posted.message).toMatchObject({ author_task_id: alice.task.id, to_kind: 'ea' })
    expect(sent.posted.message.text).toBe(`A file for you to read in my files: For my role pack\n- \`${real}\``)
    expect(listed(path.join(workspaceDir(alice.task.id), 'inbox'))).toEqual([])
    await auditEvents.settled()
    expect(await auditEvents.latest('team.file_sent')).toMatchObject({
      summary: `@${alice.handle} sent 1 file (22 B) to @ea`,
      detail: { to: 'ea', to_task_id: null },
    })
  })

  it('refuses key, credential and env files and keeps the reach and size rules', async () => {
    write(path.join(alice.cwd, 'credentials.json'), '{}')
    await expect(sendFiles(alice.task, { to: 'ea', paths: ['credentials.json'] }, by)).rejects.toThrow(
      'the EA never reads those',
    )
    write(path.join(alice.cwd, '.notes', 'plan.md'), 'plan')
    await expect(sendFiles(alice.task, { to: 'ea', paths: ['.notes/plan.md'] }, by)).rejects.toThrow('dot file')
    const outside = write(path.join(scratch, 'outside', 'host.txt'), 'host')
    await expect(sendFiles(alice.task, { to: 'ea', paths: [outside] }, by)).rejects.toThrow('outside your working')
  })

  it('lets an agent name ea in send_file, but not all or user', async () => {
    write(path.join(alice.cwd, 'plan.md'), 'plan')
    const [tool] = HANDOFF_TOOLS
    if (tool === undefined) {
      throw new Error('no send_file tool')
    }
    const result = await callSetiTool(tool, alice.task.id, { to: '@ea', paths: ['plan.md'] })
    expect('isError' in result).toBe(false)
    for (const to of ['all', 'user']) {
      const refused = await callSetiTool(tool, alice.task.id, { to, paths: ['plan.md'] })
      expect('isError' in refused).toBe(true)
    }
  })

  it('lets the EA read the file it got whole, with credentials redacted and secret files refused', async () => {
    const file = write(path.join(alice.cwd, 'notes', 'role.md'), 'Line one\nAPI_TOKEN=abcd1234efgh5678\n')
    const { files } = await sendFiles(alice.task, { to: 'ea', paths: [file] }, by)
    const base = `/api/tasks/${alice.task.id}/files`
    const [found] = await dataOf<{ root: string; path: string }[]>(
      await asEa(`${base}/resolve?p=${encodeURIComponent(files[0]?.path ?? '')}`),
    )
    const read = await asEa(`${base}/text?root=${found?.root ?? ''}&path=${encodeURIComponent(found?.path ?? '')}`)
    expect(read.status).toBe(200)
    expect((await dataOf<{ text: string }>(read)).text).toBe('Line one\nAPI_TOKEN=[redacted]\n')
    write(path.join(alice.cwd, 'credentials.json'), '{"key": "value"}')
    const secret = `${base}/text?root=${found?.root ?? ''}&path=credentials.json`
    expect((await asEa(secret)).status).toBe(403)
    const user = await app.request(secret, { headers: { ...JSON_HEADERS, ...USER_AUTH } })
    expect(user.status).toBe(200)
  })

  it('keeps secret files and credentials out of the Files search the EA runs', async () => {
    write(path.join(alice.cwd, 'credentials.txt'), 'needle')
    write(path.join(alice.cwd, 'app.env.md'), 'API_SECRET=abcd1234efgh5678 needle')
    const search = async (headers: Record<string, string>) =>
      dataOf<{ hits: { path: string; text: string }[] }>(
        await app.request(`/api/tasks/${alice.task.id}/files/search?q=needle&mode=text`, {
          headers: { ...JSON_HEADERS, ...headers },
        }),
      )
    expect((await search(EA_AUTH)).hits).toEqual([
      expect.objectContaining({ path: 'app.env.md', text: 'API_SECRET=[redacted] needle' }),
    ])
    expect((await search(USER_AUTH)).hits.map((hit) => hit.path).toSorted((a, b) => a.localeCompare(b, 'en'))).toEqual([
      'app.env.md',
      'credentials.txt',
    ])
  })
})
