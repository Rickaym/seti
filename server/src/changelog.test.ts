import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SetiVersionApi } from '@seti/mod-api'
import type { Changelog } from '@seti/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { asMod } from './access.js'
import { isNotable, parseCommit, readChangelog } from './changelog.js'
import { versionApi } from './mods/version.js'
import { changelogStore } from './store/changelog.js'
import { checkForUpdate, updateCommand } from './update-check.js'

/** The seti.version capability on `dir`, called as a mod that holds it, or one that does not. */
const versionOf = (dir: string, granted = true): SetiVersionApi =>
  versionApi(async (fn) => asMod({ id: 'whats-new', grants: granted ? ['seti.version'] : [] }, fn), dir)

describe('parseCommit', () => {
  it('splits type, scope, description and the squash-merge PR number', () => {
    expect(parseCommit('fix(ea): keep tools within the limit (#261)', 'Body text.\n')).toEqual({
      type: 'fix',
      scope: 'ea',
      breaking: false,
      description: 'keep tools within the limit',
      pr: 261,
      body: 'Body text.',
    })
  })

  it('reads a subject without a scope or PR number', () => {
    expect(parseCommit('feat: grid view', '')).toMatchObject({
      type: 'feat',
      scope: null,
      description: 'grid view',
      pr: null,
    })
  })

  it('marks breaking changes from the bang or a footer', () => {
    expect(parseCommit('feat(api)!: drop v1 (#9)', '')).toMatchObject({ type: 'feat', scope: 'api', breaking: true })
    expect(parseCommit('refactor: rename', 'Details.\n\nBREAKING CHANGE: the old name is gone')).toMatchObject({
      breaking: true,
    })
  })

  it('keeps a subject that is not conventional as the description', () => {
    expect(parseCommit('Initial import (#3)', '')).toEqual({
      type: null,
      scope: null,
      breaking: false,
      description: 'Initial import',
      pr: 3,
      body: '',
    })
    expect(parseCommit('feat:', '')).toMatchObject({ type: null, description: 'feat:' })
    expect(parseCommit('fix(): empty scope', '')).toMatchObject({ type: 'fix', scope: null })
  })

  it('reads a merge commit by the PR title in its body', () => {
    expect(parseCommit('Merge pull request #12 from me/grid', 'feat(ui): grid view\n\nMore words.')).toEqual({
      type: 'feat',
      scope: 'ui',
      breaking: false,
      description: 'grid view',
      pr: 12,
      body: 'More words.',
    })
    expect(parseCommit('Merge pull request #13 from me/x', '')).toMatchObject({ type: null, pr: 13 })
    expect(parseCommit("Merge branch 'main' into dev", '')).toMatchObject({ type: null, pr: null })
  })

  it('counts features, fixes and speed-ups, but not dependency bumps or upkeep', () => {
    expect(isNotable({ type: 'feat', scope: null })).toBe(true)
    expect(isNotable({ type: 'fix', scope: 'ea' })).toBe(true)
    expect(isNotable({ type: 'perf', scope: null })).toBe(true)
    expect(isNotable({ type: 'fix', scope: 'deps' })).toBe(false)
    expect(isNotable({ type: 'chore', scope: null })).toBe(false)
    expect(isNotable({ type: 'docs', scope: null })).toBe(false)
    expect(isNotable({ type: null, scope: null })).toBe(false)
  })
})

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Seti Test',
  GIT_AUTHOR_EMAIL: 'test@seti.invalid',
  GIT_COMMITTER_NAME: 'Seti Test',
  GIT_COMMITTER_EMAIL: 'test@seti.invalid',
}

/** Runs git in `dir`; a `date` dates the commit it makes. */
const runAt = (dir: string, date: string | null, ...args: string[]) =>
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH
  execFileSync('git', args, {
    cwd: dir,
    env: date === null ? GIT_ENV : { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    encoding: 'utf8',
  }).trim()

const run = (dir: string, ...args: string[]) => runAt(dir, null, ...args)

function commit(dir: string, message: string, day: number): string {
  const date = `2026-10-${String(day).padStart(2, '0')}T12:00:00Z`
  fs.writeFileSync(path.join(dir, 'log.txt'), `${message}\n`, { flag: 'a' })
  run(dir, 'add', 'log.txt')
  runAt(dir, date, 'commit', '-q', '-m', message)
  return run(dir, 'rev-parse', 'HEAD')
}

/** A repo with upkeep, features, fixes and a merged branch, oldest first. */
function seedRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-changelog-'))
  run(dir, 'init', '-q', '--initial-branch=main')
  commit(dir, 'chore: seed', 1)
  const feat = commit(dir, 'feat: add the grid (#1)', 2)
  const fix = commit(dir, 'fix(ea)!: keep tools in range (#2)\n\nThe EA went quiet on calls.', 3)
  commit(dir, 'chore(deps): bump zod (#3)', 3)
  run(dir, 'checkout', '-q', '-b', 'side')
  commit(dir, 'wip on the side', 4)
  run(dir, 'checkout', '-q', 'main')
  runAt(
    dir,
    '2026-10-04T13:00:00Z',
    'merge',
    '-q',
    '--no-ff',
    'side',
    '-m',
    'Merge pull request #4 from me/side\n\nperf: faster lists',
  )
  const docs = commit(dir, 'docs: explain the grid', 5)
  return { dir, shas: { feat, fix, docs } }
}

describe('the seti.version capability', () => {
  let repo: ReturnType<typeof seedRepo>
  let version: SetiVersionApi

  const flags = (log: Changelog) => log.entries.map((e) => [e.description, e.current, e.unseen])

  beforeAll(async () => {
    repo = seedRepo()
    version = versionOf(repo.dir)
    await version.start()
  })

  it('lists first-parent commits, newest first, with the running version', async () => {
    const log = await version.changelog(200)
    expect(log.version).toEqual({ commit: repo.shas.docs, date: '2026-10-05T12:00:00.000Z' })
    expect(log.entries.map((e) => [e.type, e.scope, e.description, e.pr, e.notable])).toEqual([
      ['docs', null, 'explain the grid', null, false],
      ['perf', null, 'faster lists', 4, true],
      ['chore', 'deps', 'bump zod', 3, false],
      ['fix', 'ea', 'keep tools in range', 2, true],
      ['feat', null, 'add the grid', 1, true],
      ['chore', null, 'seed', null, false],
    ])
    expect(log.entries[3]).toMatchObject({ breaking: true, body: 'The EA went quiet on calls.' })
    expect(log.has_more).toBe(false)
    expect(log.unseen).toBe(0)
  })

  it('marks what the deploy brought as current and unseen until the user opens it', async () => {
    await changelogStore.recordDeploy(repo.shas.feat)
    const log = await version.changelog(200)
    expect(flags(log)).toEqual([
      ['explain the grid', true, false],
      ['faster lists', true, true],
      ['bump zod', true, false],
      ['keep tools in range', true, true],
      ['add the grid', false, false],
      ['seed', false, false],
    ])
    expect(log.unseen).toBe(2)
    expect(await version.status()).toMatchObject({ version: log.version, unseen: 2 })
  })

  it('counts unseen from the commit the user last saw', async () => {
    await version.markSeen(repo.shas.fix)
    expect((await version.status()).unseen).toBe(1)
    expect((await version.changelog(200)).entries.filter((e) => e.unseen).map((e) => e.description)).toEqual([
      'faster lists',
    ])
    await version.markSeen(repo.shas.docs)
    expect((await version.status()).unseen).toBe(0)
  })

  it('falls back to the deploy when git does not know the seen commit', async () => {
    await version.markSeen('0'.repeat(40))
    expect((await version.status()).unseen).toBe(2)
  })

  it('pages with a limit and refuses a malformed seen commit or limit', async () => {
    const log = await version.changelog(2)
    expect(log.entries).toHaveLength(2)
    expect(log.has_more).toBe(true)
    await expect(version.markSeen('HEAD')).rejects.toThrow('Send a full commit hash')
    await expect(version.changelog(0)).rejects.toThrow(/A changelog limit/)
  })

  it('answers only a mod that holds it', async () => {
    await expect(versionOf(repo.dir, false).status()).rejects.toThrow(/was not granted seti.version/)
    await expect(versionApi(async (fn) => fn(), repo.dir).status()).rejects.toThrow(/answers only a mod/)
  })
})

describe('outside a git checkout', () => {
  it('answers an empty changelog', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-no-git-'))
    expect(await readChangelog(dir, 50)).toEqual({ version: null, unseen: 0, entries: [], has_more: false })
  })

  it('ignores the history of a repo the directory only sits inside', async () => {
    const { dir } = seedRepo()
    const inner = path.join(dir, 'server')
    fs.mkdirSync(inner)
    expect((await readChangelog(inner, 50)).version).toBeNull()
  })
})

describe('the update check', () => {
  const cloneWithOrigin = () => {
    const { dir, shas } = seedRepo()
    const origin = `${dir}-origin.git`
    run(dir, 'clone', '-q', '--bare', dir, origin)
    run(dir, 'remote', 'add', 'origin', origin)
    return { dir, origin, running: shas.docs }
  }

  it('says the checkout is current when the branch has nothing new', async () => {
    const { dir, running } = cloneWithOrigin()
    expect(await checkForUpdate(dir)).toMatchObject({
      state: 'current',
      branch: 'main',
      latest: { commit: running },
      behind: 0,
      notable: 0,
      error: null,
    })
  })

  it('counts the commits, and the features and fixes, that the checkout lacks', async () => {
    const { dir, origin } = cloneWithOrigin()
    const ahead = `${dir}-ahead`
    run(dir, 'clone', '-q', origin, ahead)
    commit(ahead, 'feat: dark mode (#6)', 6)
    const newest = commit(ahead, 'chore: tidy', 7)
    run(ahead, 'push', '-q', 'origin', 'main')

    const update = await versionOf(dir).update()
    expect(update).toMatchObject({
      state: 'available',
      latest: { commit: newest, date: '2026-10-07T12:00:00.000Z' },
      behind: 2,
      notable: 1,
    })
    expect(update.command).toContain('origin/main')
  })

  it('says why it cannot tell when the checkout has no origin', async () => {
    const { dir } = seedRepo()
    const update = await checkForUpdate(dir)
    expect(update).toMatchObject({ state: 'unknown', latest: null, behind: null })
    expect(update.error).toMatch(/origin/)
  })

  it('names the upgrade script when the checkout has one, and quotes odd paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seti update-'))
    expect(updateCommand(dir).split('\n')[0]).toBe(`cd '${dir}'`)
    fs.mkdirSync(path.join(dir, 'scripts'))
    fs.writeFileSync(path.join(dir, 'scripts', 'upgrade.sh'), '')
    expect(updateCommand(dir).split('\n')[1]).toBe('scripts/upgrade.sh')
  })
})
