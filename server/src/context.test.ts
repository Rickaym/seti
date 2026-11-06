import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { listContextFiles, readContextFile, resolveContextFile, writeContextFile } from './context-files.js'
import { repos, tasks } from './db.js'
import { HttpError } from './http.js'
import { contextPackPrompt } from './seti-guide.js'
import { contextPacks, taskContextPacks } from './store/context.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-context-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

const repoDir = path.join(scratch, 'repo')
const repoId = '00000000-0000-4000-8000-000000000001'

async function statusOf(fn: () => unknown): Promise<number | null> {
  try {
    await fn()
    return null
  } catch (e) {
    return e instanceof HttpError ? e.status : -1
  }
}

beforeAll(async () => {
  fs.mkdirSync(repoDir, { recursive: true })
  await repos.insert({ id: repoId, slug: 'acme/repo', path: repoDir, base_branch: 'main', created_at: '2026-01-01' })
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

afterEach(() => {
  fs.rmSync(path.join(scratch, 'claude'), { recursive: true, force: true })
  for (const name of ['CLAUDE.md', 'CLAUDE.local.md']) {
    fs.rmSync(path.join(repoDir, name), { force: true })
  }
})

describe('resolveContextFile', () => {
  it('maps keys to the user and repo files', async () => {
    expect((await resolveContextFile('user')).path).toBe(path.join(scratch, 'claude', 'CLAUDE.md'))
    expect((await resolveContextFile(`repo:${repoId}:project`)).path).toBe(path.join(repoDir, 'CLAUDE.md'))
    expect((await resolveContextFile(`repo:${repoId}:local`)).path).toBe(path.join(repoDir, 'CLAUDE.local.md'))
  })

  it.each([
    'project',
    '../etc/passwd',
    '/etc/passwd',
    `repo:${repoId}:other`,
    `repo:${repoId}:project:extra`,
    `repo:${repoId}/../x:project`,
    'repo::project',
  ])('rejects unknown key %s', async (key) => {
    expect(await statusOf(async () => resolveContextFile(key))).toBe(404)
  })

  it('rejects repos Seti does not know', async () => {
    expect(await statusOf(async () => resolveContextFile('repo:11111111-1111-4111-8111-111111111111:project'))).toBe(
      404,
    )
  })

  it('lists the user file then both files per repo', async () => {
    expect((await listContextFiles()).map((f) => [f.key, f.group, f.exists])).toEqual([
      ['user', 'User level', false],
      [`repo:${repoId}:project`, 'acme/repo', false],
      [`repo:${repoId}:local`, 'acme/repo', false],
    ])
  })
})

describe('writeContextFile', () => {
  it('creates a missing file with a trailing newline and returns its hash', async () => {
    const written = await writeContextFile('user', '# Rules', null)
    expect(fs.readFileSync(written.path, 'utf8')).toBe('# Rules\n')
    expect(written).toMatchObject({ exists: true, content: '# Rules\n', size: 8 })
    expect(written.hash).toBe((await readContextFile('user')).hash)
  })

  it('keeps an existing trailing newline and empty content as is', async () => {
    expect((await writeContextFile(`repo:${repoId}:project`, 'a\n', null)).content).toBe('a\n')
    expect((await writeContextFile(`repo:${repoId}:local`, '', null)).content).toBe('')
  })

  it('refuses to create over a file that appeared meanwhile', async () => {
    fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), 'from disk\n')
    expect(await statusOf(async () => writeContextFile(`repo:${repoId}:project`, 'mine', null))).toBe(409)
    expect(fs.readFileSync(path.join(repoDir, 'CLAUDE.md'), 'utf8')).toBe('from disk\n')
  })

  it('refuses a stale hash and accepts the current one', async () => {
    const first = await writeContextFile(`repo:${repoId}:project`, 'one', null)
    fs.writeFileSync(first.path, 'edited elsewhere\n')
    expect(await statusOf(async () => writeContextFile(first.key, 'two', first.hash))).toBe(409)
    const fresh = await readContextFile(first.key)
    expect((await writeContextFile(first.key, 'two', fresh.hash)).content).toBe('two\n')
  })

  it('refuses when the file was deleted after loading', async () => {
    const first = await writeContextFile('user', 'one', null)
    fs.rmSync(first.path)
    expect(await statusOf(async () => writeContextFile('user', 'two', first.hash))).toBe(409)
  })

  it('writes atomically through a temp file and leaves nothing behind', async () => {
    const first = await writeContextFile(`repo:${repoId}:project`, 'one', null)
    const inode = fs.statSync(first.path).ino
    await writeContextFile(first.key, 'two', first.hash)
    expect(fs.statSync(first.path).ino).not.toBe(inode)
    expect(fs.readdirSync(repoDir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('writes through a symlink to its target', async () => {
    const target = path.join(scratch, 'shared-rules.md')
    fs.writeFileSync(target, 'old\n')
    const link = path.join(repoDir, 'CLAUDE.md')
    fs.symlinkSync(target, link)
    await writeContextFile(`repo:${repoId}:project`, 'new', (await readContextFile(`repo:${repoId}:project`)).hash)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(target, 'utf8')).toBe('new\n')
  })

  it('does not create a missing repo checkout', async () => {
    const goneId = '00000000-0000-4000-8000-000000000002'
    await repos.insert({
      id: goneId,
      slug: 'acme/gone',
      path: path.join(scratch, 'gone'),
      base_branch: 'main',
      created_at: '',
    })
    expect(await statusOf(async () => writeContextFile(`repo:${goneId}:project`, 'x', null))).toBe(400)
    await repos.remove(goneId)
  })
})

describe('context packs', () => {
  it('rejects duplicate names and unknown ids', async () => {
    await contextPacks.create({ name: 'Dup', description: '', body: 'x' })
    expect(await statusOf(async () => contextPacks.create({ name: 'Dup', description: '', body: 'y' }))).toBe(409)
    const unknownId = '22222222-2222-4222-8222-222222222222'
    expect(
      await statusOf(async () => {
        await contextPacks.assertLinkable([unknownId])
      }),
    ).toBe(400)
  })

  it('builds the prompt from the packs attached to a task and follows edits', async () => {
    const taskId = '33333333-3333-4333-8333-333333333333'
    await tasks.insert({ id: taskId, title: 't', repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
    const alpha = await contextPacks.create({ name: 'Alpha', description: 'first', body: 'alpha body\n' })
    const beta = await contextPacks.create({ name: 'Beta', description: '', body: 'beta body' })
    expect(await contextPackPrompt(taskId)).toMatch(/^# Seti guide/)
    await taskContextPacks.set(taskId, [])
    expect(await contextPackPrompt(taskId)).toBeNull()

    await taskContextPacks.set(taskId, [beta.id, alpha.id])
    expect((await taskContextPacks.list(taskId)).map((p) => p.name)).toEqual(['Alpha', 'Beta'])
    expect(await contextPackPrompt(taskId)).toBe(
      [
        'The user attached these context packs to this task. Treat them as reference material.',
        '## Context pack: Alpha',
        'alpha body',
        '## Context pack: Beta',
        'beta body',
      ].join('\n\n'),
    )

    await contextPacks.update(alpha.id, { name: 'Alpha', description: '', body: 'edited' })
    await taskContextPacks.set(taskId, [alpha.id])
    expect(await contextPackPrompt(taskId)).toContain('## Context pack: Alpha\n\nedited')
    expect(await contextPackPrompt(taskId)).not.toContain('Beta')

    await contextPacks.remove(alpha.id)
    expect(await contextPackPrompt(taskId)).toBeNull()
    await tasks.remove(taskId)
  })
})
