import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { gitBadge, unsavedWork } from './git-state.js'
import {
  agentGit,
  agentGitReading,
  agentGitWrite,
  forgetWorktree,
  git,
  hasLocalChanges,
  mainCheckout,
  saveUncommitted,
  worktreeState,
} from './git.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seti-hostile-git-')))
const ran = path.join(root, 'ran')
fs.mkdirSync(ran)

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** An executable in the repository, as an agent would leave one, that marks the host when run. */
function trap(repo: string, name: string, then = 'exit 0'): string {
  const dir = path.join(repo, '.git', 'traps')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, `#!/bin/sh\ntouch ${path.join(ran, name)}\n${then}\n`, { mode: 0o755 })
  return file
}

const sprung = () => fs.readdirSync(ran).toSorted((a, b) => a.localeCompare(b, 'en'))
const reset = () => {
  for (const name of fs.readdirSync(ran)) {
    fs.rmSync(path.join(ran, name))
  }
}

function plain(cwd: string, ...args: string[]): string {
  const identity = [
    '-c',
    'user.name=Seti Test',
    '-c',
    'user.email=test@seti.invalid',
    '-c',
    'protocol.file.allow=always',
  ]
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like git.ts
  return execFileSync('git', [...identity, '-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
}

const HOOKS = ['post-index-change', 'pre-commit', 'post-checkout', 'reference-transaction', 'post-commit']

/** A commit carrying a signature, which `log.showSignature` hands to the signing program. */
function signedCommit(repo: string): void {
  const tree = plain(repo, 'rev-parse', 'HEAD^{tree}')
  const parent = plain(repo, 'rev-parse', 'HEAD')
  const signature = 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n x\n -----END PGP SIGNATURE-----'
  const body = `tree ${tree}\nparent ${parent}\nauthor A <a@a> 1 +0000\ncommitter A <a@a> 1 +0000\n${signature}\n\nsigned\n`
  const file = path.join(root, 'signed-commit')
  fs.writeFileSync(file, body)
  const id = plain(repo, 'hash-object', '-t', 'commit', '-w', '--literally', file)
  plain(repo, 'update-ref', 'refs/heads/signed', id)
}

/** A submodule whose own config names a clean filter, which status runs from its parent. */
function hostileSubmodule(repo: string): void {
  const sub = path.join(repo, 'sub')
  fs.mkdirSync(sub)
  plain(sub, 'init', '-q', '--initial-branch=main')
  fs.writeFileSync(path.join(sub, 'inner.txt'), 'inner\n')
  fs.writeFileSync(path.join(sub, '.gitattributes'), '*.txt filter=inner\n')
  plain(sub, 'add', '.')
  plain(sub, 'commit', '-qm', 'inner')
  plain(sub, 'config', 'filter.inner.clean', `${trap(repo, 'submodule-filter')} ; cat`)
  plain(repo, 'add', 'sub')
}

/** A clone as an agent could leave it: every way its config and files can name a program. */
function hostileRepo(name: string): string {
  const repo = path.join(root, name)
  fs.mkdirSync(repo)
  plain(repo, 'init', '-q', '--initial-branch=main')
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'first\n')
  fs.writeFileSync(path.join(repo, 'data.dat'), 'data\n')
  fs.writeFileSync(path.join(repo, 'blob.bin'), 'blob\n')
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt diff=evil merge=evil filter=evil\n')
  fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.dat filter=hidden\n')
  hostileSubmodule(repo)
  plain(repo, 'add', '.')
  plain(repo, 'commit', '-qm', 'seed')
  signedCommit(repo)
  for (const hook of HOOKS) {
    fs.copyFileSync(trap(repo, `hook-${hook}`), path.join(repo, '.git', 'hooks', hook))
  }
  const included = path.join(repo, '.git', 'included.gitconfig')
  fs.writeFileSync(included, `[core]\n\tpager = ${trap(repo, 'included-pager', 'cat')}\n`)
  const settings: [string, string][] = [
    ['filter.evil.clean', `${trap(repo, 'filter-clean')} ; cat`],
    ['filter.evil.smudge', `${trap(repo, 'filter-smudge')} ; cat`],
    ['filter.hidden.clean', `${trap(repo, 'info-attributes-filter')} ; cat`],
    ['core.fsmonitor', trap(repo, 'fsmonitor')],
    ['core.pager', trap(repo, 'pager', 'cat')],
    ['core.editor', trap(repo, 'editor')],
    ['sequence.editor', trap(repo, 'sequence-editor')],
    ['core.sshCommand', trap(repo, 'ssh')],
    ['core.askPass', trap(repo, 'askpass')],
    ['credential.helper', `!${trap(repo, 'credential')}`],
    ['diff.external', trap(repo, 'external-diff')],
    ['diff.evil.textconv', trap(repo, 'textconv', 'cat "$1"')],
    ['diff.evil.command', trap(repo, 'diff-driver')],
    ['merge.evil.driver', trap(repo, 'merge-driver')],
    ['gpg.program', trap(repo, 'gpg')],
    ['gpg.ssh.program', trap(repo, 'gpg-ssh')],
    ['log.showSignature', 'true'],
    ['status.submoduleSummary', 'true'],
    ['alias.status', `!${trap(repo, 'alias')}`],
    ['include.path', included],
  ]
  for (const [key, value] of settings) {
    plain(repo, 'config', key, value)
  }
  reset()
  return repo
}

/** Same-size edits, so git must read each file through its filter to see whether it changed. */
function touchAll(repo: string): void {
  const edits: [string, string][] = [
    ['notes.txt', 'FIRST\n'],
    ['data.dat', 'DATA\n'],
    ['blob.bin', 'BLOB\n'],
    ['sub/inner.txt', 'INNER\n'],
  ]
  for (const [file, text] of edits) {
    fs.writeFileSync(path.join(repo, file), text)
  }
}

/** Every git call shape Seti makes in an agent's folder, the writes and saveUncommitted aside. */
const READS: string[][] = [
  ['status', '--porcelain'],
  ['status', '--porcelain=v2', '--branch'],
  ['status', '--porcelain', '--ignored', '--untracked-files=all', '--', 'notes.txt'],
  ['status', '--porcelain', '--untracked-files=all'],
  ['rev-parse', 'HEAD'],
  ['rev-parse', '--verify', '--quiet', 'HEAD'],
  ['symbolic-ref', '--quiet', '--short', 'HEAD'],
  ['branch', '--remotes', '--contains', 'HEAD'],
  ['rev-list', '--count', 'HEAD', '--branches', '--not', '--remotes'],
  ['rev-list', '--count', 'HEAD', '--not', '--remotes'],
  ['ls-files', '--', 'notes.txt'],
  ['ls-files', '-z', '--', 'notes.txt', 'blob.bin'],
  ['check-ignore', '--quiet', '--', 'notes.txt'],
  ['stash', 'list'],
  ['worktree', 'list', '--porcelain'],
  ['config', '--get-regexp', '^url\\.'],
  ['remote'],
  ['diff'],
  ['log', '-1', '-p', 'signed'],
  ['show', 'signed'],
]

describe('git in a repository an agent controls', () => {
  it('is a trap for plain git, which proves the repository is hostile', () => {
    const repo = hostileRepo('control')
    touchAll(repo)
    plain(repo, 'status', '--porcelain')
    plain(repo, 'diff')
    plain(repo, 'log', '-1', 'signed')
    expect(sprung()).toEqual(
      expect.arrayContaining(['filter-clean', 'info-attributes-filter', 'submodule-filter', 'gpg', 'diff-driver']),
    )
  })

  it('runs nothing the repository names on the host for any call Seti makes', async () => {
    const repo = hostileRepo('reads')
    touchAll(repo)
    for (const args of READS) {
      await agentGit(repo, ...args).catch(() => '')
    }
    const files = [path.join(repo, '.git', 'included.gitconfig')]
    await agentGitReading(0, repo, files, 'config', '--get', 'remote.origin.url').catch(() => '')
    expect(await hasLocalChanges(repo)).toBe(true)
    expect(await worktreeState(repo)).toMatchObject({ branch: 'main', dirty: true, pushed: false })
    expect(await gitBadge(repo)).toMatchObject({ branch: 'main' })
    expect(await unsavedWork(repo)).toBe(`${repo} has uncommitted changes`)
    expect(sprung()).toEqual([])
  })

  it('changes branches and saves uncommitted work without running anything on the host', async () => {
    const repo = hostileRepo('archived')
    touchAll(repo)
    fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked\n')
    await agentGitWrite(repo, 'branch', '--', 'spare', 'HEAD')
    await agentGitWrite(repo, 'branch', '-D', '--', 'spare')
    await agentGitWrite(repo, 'worktree', 'repair').catch(() => '')
    const patch = path.join(fs.mkdtempSync(path.join(root, 'patches-')), 'archived.patch')
    await saveUncommitted(repo, patch)
    const saved = fs.readFileSync(patch, 'utf8')
    expect(saved).toContain('+FIRST')
    expect(saved).toContain('+untracked')
    expect(sprung()).toEqual([])
  })

  it('starts no long-running filter process the repository names, which plain git starts', async () => {
    const repo = hostileRepo('process')
    fs.appendFileSync(path.join(repo, '.gitattributes'), '*.bin filter=proc\n')
    plain(repo, 'config', 'filter.proc.process', trap(repo, 'filter-process'))
    touchAll(repo)
    expect(() => plain(repo, 'status', '--porcelain')).toThrow()
    expect(sprung()).toContain('filter-process')
    reset()
    for (const args of READS) {
      await agentGit(repo, ...args).catch(() => '')
    }
    const patch = path.join(fs.mkdtempSync(path.join(root, 'patches-')), 'process.patch')
    await saveUncommitted(repo, patch).catch(() => undefined)
    expect(sprung()).toEqual([])
  })

  it('reaches no remote, so no ssh command, proxy or credential helper of the repository starts', async () => {
    const repo = hostileRepo('remote')
    plain(repo, 'remote', 'add', 'origin', 'ssh://git@example.invalid/acme/app.git')
    await expect(agentGit(repo, 'fetch', 'origin')).rejects.toThrow()
    await expect(agentGit(repo, 'ls-remote', 'https://example.invalid/acme/app.git')).rejects.toThrow()
    expect(sprung()).toEqual([])
  })

  it('ignores the system and user config, so only its own overrides and the repository apply', async () => {
    const repo = hostileRepo('scoped')
    const shown = await agentGit(repo, 'config', '--show-scope', '--get-regexp', '^core\\.(fsmonitor|hookspath|pager)$')
    expect(shown.split('\n').filter((line) => line.startsWith('command'))).toEqual([
      'command\tcore.hookspath /dev/null',
      'command\tcore.fsmonitor false',
      'command\tcore.pager cat',
    ])
    expect(await agentGit(repo, 'config', '--get', 'core.fsmonitor')).toBe('false')
    expect(await agentGit(repo, 'config', '--list', '--show-scope')).not.toMatch(/^(system|global)\t/m)
  })

  it('finds a main checkout from its files and forgets a removed worktree without running anything', async () => {
    const repo = hostileRepo('main')
    const stray = path.join(root, 'stray')
    plain(repo, 'worktree', 'add', '-q', '--detach', stray)
    reset()
    expect(mainCheckout(stray)).toBe(repo)
    expect(mainCheckout(repo)).toBeNull()
    expect(mainCheckout(root)).toBeNull()
    expect(await agentGit(stray, 'status', '--porcelain')).toBe('')
    fs.rmSync(stray, { recursive: true })
    await forgetWorktree(repo, stray)
    expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toContain(stray)
    expect(sprung()).toEqual([])
  })
})
