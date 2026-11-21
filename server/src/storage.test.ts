import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { CleanPlan, RemovalResult, StorageOverview, StorageSchedule, Task, TreeListing } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { asAgent } from './access.js'
import { createApp } from './app.js'
import { SCRATCH_ROOT, WORKTREE_ROOT } from './config.js'
import { repos, sql, tasks } from './db.js'
import { nestedRefusal, sandboxDirOf } from './owned-dirs.js'
import { settled } from './size-cache.js'
import { cleanAgent } from './storage-clean.js'
import { removeOrphans } from './storage-orphans.js'
import { dueForClean, sweepIdleClean } from './storage-schedule.js'
import { auditEvents } from './store/audit.js'
import { createScratchDir } from './task-location.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

const seti = createApp()
const DAY = 24 * 60 * 60 * 1000

const send = async (auth: Record<string, string>, method: string, route: string, body?: unknown) =>
  seti.request(`/api${route}`, {
    method,
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const request = async (method: string, route: string, body?: unknown) => send(USER_AUTH, method, route, body)

async function data<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200)
  return ((await response.json()) as { data: T }).data
}

const byText = (a: string, b: string) => a.localeCompare(b)

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

function git(cwd: string, ...args: string[]): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like the server
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t.invalid', ...args], {
    cwd,
    env: GIT_ENV,
    stdio: 'pipe',
  })
    .toString()
    .trim()
}

function write(file: string, text = 'x'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function aged(dir: string): string {
  const when = new Date(Date.now() - 30 * DAY)
  for (const entry of [dir, ...fs.readdirSync(dir).map((name) => path.join(dir, name))]) {
    fs.utimesSync(entry, when, when)
  }
  return dir
}

/** An idle agent whose scratch folder holds source, dependencies and a repo with build output. */
async function seededAgent(title: string): Promise<{ task: Task; scratch: string }> {
  const id = randomUUID()
  const scratch = createScratchDir(id, title)
  write(path.join(scratch, 'notes.md'), '# notes\n')
  write(path.join(scratch, 'node_modules', 'left-pad', 'index.js'), 'x'.repeat(4096))
  const app = path.join(scratch, 'app')
  fs.mkdirSync(app)
  git(app, 'init', '-q', '--initial-branch=main')
  write(path.join(app, '.gitignore'), 'dist/\n')
  write(path.join(app, 'src', 'main.ts'), 'export const x = 1\n')
  write(path.join(app, 'vendor', 'node_modules', 'pinned.js'), 'tracked')
  git(app, 'add', '-A', '-f')
  git(app, 'commit', '-q', '-m', 'seed')
  write(path.join(app, 'src', 'main.ts'), 'export const x = 2\n')
  write(path.join(app, 'dist', 'out.js'), 'built')
  write(path.join(app, 'build', 'notes.txt'), 'not ignored')
  write(path.join(sandboxDirOf(id), 'tmp', 'scratch.log'), 'tmp')
  write(path.join(sandboxDirOf(id), 'home', '.ssh', 'id_ed25519'), 'secret')
  await tasks.insert({ id, title, repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('task not inserted')
  }
  return { task, scratch }
}

describe('Clean', () => {
  it('plans only rebuildable folders, removes them on confirm and audits each', async () => {
    const { task, scratch } = await seededAgent('Clean me')
    const plan = await data<CleanPlan>(await request('GET', `/storage/agents/${task.id}/clean`))
    const sandbox = sandboxDirOf(task.id)
    expect(plan.refused).toBeNull()
    expect(plan.targets.map((target) => target.dir).toSorted(byText)).toEqual(
      [path.join(scratch, 'app', 'dist'), path.join(scratch, 'node_modules'), path.join(sandbox, 'tmp')].toSorted(
        byText,
      ),
    )
    expect(plan.kept.map((kept) => kept.dir)).toEqual(
      expect.arrayContaining([path.join(scratch, 'app', 'build'), path.join(scratch, 'app', 'vendor', 'node_modules')]),
    )

    expect((await request('POST', `/storage/agents/${task.id}/clean`, { dirs: [scratch] })).status).toBe(400)
    const result = await data<RemovalResult>(
      await request('POST', `/storage/agents/${task.id}/clean`, {
        dirs: [path.join(scratch, 'node_modules'), path.join(scratch, 'app', 'src'), scratch],
        confirm: true,
      }),
    )

    expect(result.removed).toEqual([{ path: path.join(scratch, 'node_modules'), bytes: 4096 }])
    expect(result.freed_bytes).toBe(4096)
    expect(result.refused.map((refused) => refused.path)).toEqual([path.join(scratch, 'app', 'src'), scratch])
    expect(fs.existsSync(path.join(scratch, 'node_modules'))).toBe(false)
    expect(fs.readFileSync(path.join(scratch, 'app', 'src', 'main.ts'), 'utf8')).toBe('export const x = 2\n')
    expect(fs.existsSync(path.join(scratch, 'app', 'dist'))).toBe(true)
    const event = await auditEvents.latest('task.storage_cleaned')
    expect(event).toMatchObject({ actor: 'user', subject_id: task.id })
    expect(event?.detail).toMatchObject({ folders: [`node_modules in ${scratch}: 4096 bytes`], freed_bytes: 4096 })
  })

  it('never cleans a running agent', async () => {
    const { task, scratch } = await seededAgent('Busy agent')
    await tasks.setStatus(task.id, 'running', null)
    const plan = await data<CleanPlan>(await request('GET', `/storage/agents/${task.id}/clean`))
    expect(plan.refused).toBe('Agent "Busy agent" is running; Clean waits until it stops')
    const refused = await request('POST', `/storage/agents/${task.id}/clean`, {
      dirs: [path.join(scratch, 'node_modules')],
      confirm: true,
    })
    expect(refused.status).toBe(409)
    expect(fs.existsSync(path.join(scratch, 'node_modules'))).toBe(true)
  })

  it('lets the EA clean one agent and refuses agents', async () => {
    const { task, scratch } = await seededAgent('EA cleans')
    const byEa = await data<RemovalResult>(
      await send(EA_AUTH, 'POST', `/storage/agents/${task.id}/clean`, {
        dirs: [path.join(scratch, 'node_modules')],
        confirm: true,
      }),
    )
    expect(byEa.removed).toHaveLength(1)
    expect((await auditEvents.latest('task.storage_cleaned'))?.detail).toMatchObject({ via: 'ea' })

    const other = await seededAgent('Other agent')
    const agent = { ...task, seti_control: 'full' as const }
    await expect(asAgent(agent, async () => cleanAgent(other.task, { actor: 'user' }))).rejects.toThrow(
      /Agents cannot clean/,
    )
    expect(fs.existsSync(path.join(other.scratch, 'node_modules'))).toBe(true)
  })
})

describe('removing a folder inside an agent folder', () => {
  it('takes only a rebuildable folder reached through no symlink, in a folder Seti made', async () => {
    const { task, scratch } = await seededAgent('Nested checks')
    const inside = { base: scratch, root: 'scratch' } as const
    fs.symlinkSync(path.join(scratch, 'app'), path.join(scratch, 'linked'))
    write(path.join(scratch, 'app', 'node_modules', 'x.js'))

    expect(nestedRefusal(path.join(scratch, 'node_modules'), inside, [])).toBeNull()
    expect(nestedRefusal(path.join(scratch, 'app', 'src'), inside, [])).toContain('is not a rebuildable folder')
    expect(nestedRefusal(path.join(scratch, 'linked', 'node_modules'), inside, [])).toContain('through a symlink')
    expect(nestedRefusal(path.join(scratch, '..', 'node_modules'), inside, [])).toContain('not a plain path')
    expect(nestedRefusal(scratch, inside, [])).toContain('not a plain path')
    expect(nestedRefusal(path.join(scratch, 'node_modules'), { base: scratch, root: 'worktrees' }, [])).toContain(
      'is not directly inside',
    )
    expect(
      nestedRefusal(path.join(scratch, 'node_modules'), inside, [{ ...task, id: 'other', cwd: scratch }]),
    ).toContain('agent other uses')
  })
})

describe('orphans', () => {
  it('lists folders no agent owns and removes only those with nothing to lose', async () => {
    const gone = path.join(SCRATCH_ROOT, 'deleted-agent-0badf00d')
    write(path.join(gone, 'big.bin'), 'x'.repeat(10_000))
    aged(gone)
    const fresh = path.join(SCRATCH_ROOT, 'starting-agent')
    write(path.join(fresh, 'a.txt'))
    const unpushed = path.join(SCRATCH_ROOT, 'unpushed-clone')
    write(path.join(unpushed, 'repo', 'README.md'))
    git(path.join(unpushed, 'repo'), 'init', '-q', '--initial-branch=main')
    git(path.join(unpushed, 'repo'), 'add', '-A')
    git(path.join(unpushed, 'repo'), 'commit', '-q', '-m', 'local only')
    aged(unpushed)
    const stray = path.join(WORKTREE_ROOT, 'stray-worktree')
    write(path.join(stray, 'file.txt'))
    aged(stray)
    const { scratch: owned } = await seededAgent('Owner')
    aged(owned)

    await data(await request('GET', '/storage'))
    await settled()
    const overview = await data<StorageOverview>(await request('GET', '/storage'))

    const byPath = new Map(overview.orphans.map((orphan) => [orphan.path, orphan]))
    expect(byPath.get(gone)).toMatchObject({ kind: 'folder', kept: null, where: SCRATCH_ROOT })
    expect(byPath.get(stray)).toMatchObject({ kept: null })
    expect(byPath.get(fresh)?.kept).toContain('changed in the last hour')
    expect(byPath.get(unpushed)?.kept).toContain('1 commit(s) that are not pushed')
    expect(byPath.has(owned)).toBe(false)

    expect((await send(EA_AUTH, 'POST', '/storage/orphans/remove', { paths: [gone], confirm: true })).status).toBe(403)
    const result = await data<RemovalResult>(
      await request('POST', '/storage/orphans/remove', { paths: [gone, unpushed, fresh, owned], confirm: true }),
    )

    expect(result.removed).toEqual([{ path: gone, bytes: 10_000 }])
    expect(result.refused.map((refused) => refused.path)).toEqual([unpushed, fresh, owned])
    expect(fs.existsSync(gone)).toBe(false)
    expect(fs.existsSync(path.join(unpushed, 'repo', 'README.md')) && fs.existsSync(owned)).toBe(true)
    expect((await auditEvents.latest('system.orphans_removed'))?.detail).toMatchObject({
      orphans: [`${gone}: 10000 bytes`],
      freed_bytes: 10_000,
    })
  })

  it('drops a worktree record whose folder is gone', async () => {
    const checkout = fs.mkdtempSync(path.join(SCRATCH_ROOT, '..', 'checkout-'))
    git(checkout, 'init', '-q', '--initial-branch=main')
    await repos.insert({
      id: 'repo-storage',
      slug: 'acme/storage',
      path: checkout,
      base_branch: 'main',
      created_at: '2026',
    })
    const { task } = await seededAgent('Lost worktree')
    const lost = path.join(WORKTREE_ROOT, 'storage-lost-1234abcd')
    await sql`INSERT INTO task_worktree (task_id, repo_id, dir) VALUES (${task.id}, 'repo-storage', ${lost})`

    const result = await removeOrphans([lost])

    expect(result.removed).toEqual([{ path: lost, bytes: null }])
    expect(await sql`SELECT 1 FROM task_worktree WHERE dir = ${lost}`).toHaveLength(0)
  })

  it('refuses agents removing orphans', async () => {
    const { task } = await seededAgent('Agent tries')
    await expect(asAgent(task, async () => removeOrphans(['/nowhere']))).rejects.toThrow(/Agents cannot remove/)
  })
})

describe('automatic clean', () => {
  it('starts off, is the user to change, and cleans only idle or archived agents that are not running', async () => {
    expect((await data<StorageOverview>(await request('GET', '/storage'))).schedule).toMatchObject({
      enabled: false,
      idle_days: 14,
    })
    expect((await send(EA_AUTH, 'PUT', '/storage/schedule', { enabled: true })).status).toBe(403)
    expect((await request('PUT', '/storage/schedule', { idle_days: 9 })).status).toBe(400)
    expect(await sweepIdleClean()).toBe(0)

    const idle = await seededAgent('Idle long')
    const recent = await seededAgent('Recent')
    const archived = await seededAgent('Archived lately')
    const running = await seededAgent('Running long')
    const old = new Date(Date.now() - 10 * DAY).toISOString()
    await sql`UPDATE task SET updated_at = ${old} WHERE id IN (${idle.task.id}, ${running.task.id})`
    await sql`UPDATE task SET archived_at = ${new Date().toISOString()} WHERE id = ${archived.task.id}`
    await tasks.setStatus(running.task.id, 'running', null)

    const on = await data<StorageSchedule>(await request('PUT', '/storage/schedule', { enabled: true, idle_days: 7 }))
    expect(on).toMatchObject({ enabled: true, idle_days: 7 })
    expect((await auditEvents.latest('system.storage_schedule_changed'))?.summary).toContain('on, for agents idle 7+')
    const cutoff = new Date(Date.now() - 7 * DAY).toISOString()
    const due = async (id: string) => {
      const task = await tasks.get(id)
      return task !== undefined && dueForClean(task, cutoff)
    }
    expect([await due(idle.task.id), await due(recent.task.id), await due(archived.task.id)]).toEqual([
      true,
      false,
      true,
    ])
    expect(await due(running.task.id)).toBe(false)

    expect(await sweepIdleClean()).toBeGreaterThanOrEqual(8192)

    expect(fs.existsSync(path.join(idle.scratch, 'node_modules'))).toBe(false)
    expect(fs.existsSync(path.join(archived.scratch, 'node_modules'))).toBe(false)
    expect(fs.existsSync(path.join(recent.scratch, 'node_modules'))).toBe(true)
    expect(fs.existsSync(path.join(running.scratch, 'node_modules'))).toBe(true)
    const schedule = (await data<StorageOverview>(await request('GET', '/storage'))).schedule
    expect(schedule.last_run_at).not.toBeNull()
    expect(schedule.last_freed_bytes).toBeGreaterThanOrEqual(8192)
    expect((await auditEvents.latest('task.storage_cleaned'))?.summary).toContain('automatic clean')
  })
})

describe('the tree', () => {
  it('lists a folder with sizes, rebuildable marks and git badges, and hides sandbox logins', async () => {
    const { task } = await seededAgent('Tree agent')
    const listing = async () => data<TreeListing>(await request('GET', `/tasks/${task.id}/files/tree?root=cwd&path=`))
    await listing()
    await settled()
    const tree = await listing()

    const byName = new Map(tree.entries.map((entry) => [entry.name, entry]))
    expect(byName.get('node_modules')).toMatchObject({ rebuildable: true, size: { bytes: 4096, capped: false } })
    expect(byName.get('app')).toMatchObject({
      rebuildable: false,
      git: { branch: 'main', dirty: 2, ahead: null, behind: null },
    })
    expect(byName.get('notes.md')).toMatchObject({ type: 'file', size: { bytes: 8 } })
    expect(tree.measuring).toBe(false)

    const app = await data<TreeListing>(await request('GET', `/tasks/${task.id}/files/tree?root=cwd&path=app`))
    expect(Object.fromEntries(app.entries.map((entry) => [entry.name, entry.rebuildable]))).toEqual({
      build: false,
      dist: true,
      src: false,
      vendor: false,
    })

    const roots = await data<{ id: string; writable: boolean }[]>(await request('GET', `/tasks/${task.id}/files/roots`))
    expect(roots.filter((root) => root.id.startsWith('sandbox'))).toEqual([
      expect.objectContaining({ id: 'sandbox-home', writable: false }),
      expect.objectContaining({ id: 'sandbox-tmp', writable: false }),
    ])
    const home = await request('GET', `/tasks/${task.id}/files/tree?root=sandbox-home&path=&dotfiles=1`)
    expect((await data<TreeListing>(home)).entries.map((entry) => entry.name)).not.toContain('.ssh')
    expect(
      (await request('GET', `/tasks/${task.id}/files/text?root=sandbox-home&path=.ssh/id_ed25519&dotfiles=1`)).status,
    ).toBe(403)
  })
})
