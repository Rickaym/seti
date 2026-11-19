import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  agentGit,
  git,
  hasLocalChanges,
  mainCheckout,
  removeLinkedWorktree,
  saveUncommitted,
  worktreeState,
} from './git.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seti-hostile-git-')))
const ran = path.join(root, 'ran')
fs.mkdirSync(ran)

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** An executable that leaves a file named after itself, then acts as git expects of it. */
function trap(name: string, then = 'exit 0'): string {
  const file = path.join(root, `trap-${name}`)
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
  const identity = ['-c', 'user.name=Seti Test', '-c', 'user.email=test@seti.invalid']
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like git.ts
  return execFileSync('git', [...identity, '-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
}

const HOOKS = ['post-index-change', 'pre-commit', 'post-checkout', 'reference-transaction', 'post-commit']

/** A clone as an agent could leave it: every way its config and hooks can start a program. */
function hostileRepo(name: string): string {
  const repo = path.join(root, name)
  fs.mkdirSync(repo)
  plain(repo, 'init', '-q', '--initial-branch=main')
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'first\n')
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt diff=evil\n')
  plain(repo, 'add', '.')
  plain(repo, 'commit', '-qm', 'seed')
  for (const hook of HOOKS) {
    fs.copyFileSync(trap(`hook-${hook}`), path.join(repo, '.git', 'hooks', hook))
  }
  const included = path.join(root, `${name}-included.gitconfig`)
  fs.writeFileSync(included, `[core]\n\tpager = ${trap('included-pager', 'cat')}\n`)
  const settings: [string, string][] = [
    ['core.fsmonitor', trap('fsmonitor')],
    ['core.pager', trap('pager', 'cat')],
    ['core.editor', trap('editor')],
    ['core.sshCommand', trap('ssh')],
    ['core.askPass', trap('askpass')],
    ['credential.helper', `!${trap('credential')}`],
    ['diff.external', trap('external-diff')],
    ['diff.evil.textconv', trap('textconv', 'cat "$1"')],
    ['diff.evil.command', trap('diff-driver')],
    ['alias.status', `!${trap('alias')}`],
    ['include.path', included],
  ]
  for (const [key, value] of settings) {
    plain(repo, 'config', key, value)
  }
  reset()
  return repo
}

describe('git in a repository an agent controls', () => {
  it('is a trap for plain git, which proves the repository is hostile', () => {
    const repo = hostileRepo('control')
    fs.appendFileSync(path.join(repo, 'notes.txt'), 'second\n')
    plain(repo, 'status', '--porcelain')
    plain(repo, 'diff')
    plain(repo, 'add', '-A')
    expect(sprung()).toEqual(expect.arrayContaining(['fsmonitor', 'diff-driver', 'hook-post-index-change']))
  })

  it('reads state and saves uncommitted work without running a hook, the fsmonitor or a diff driver', async () => {
    const repo = hostileRepo('archived')
    fs.appendFileSync(path.join(repo, 'notes.txt'), 'second\n')
    fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked\n')

    expect(await hasLocalChanges(repo)).toBe(true)
    expect(await worktreeState(repo)).toMatchObject({ branch: 'main', dirty: true, pushed: false })
    expect(await agentGit(repo, 'diff')).toContain('+second')
    expect(await agentGit(repo, 'log', '-1', '-p', '--format=%s')).toContain('+first')
    expect(await agentGit(repo, 'show', 'HEAD')).toContain('+first')
    const patch = path.join(root, 'archived.patch')
    await saveUncommitted(repo, patch)
    const saved = fs.readFileSync(patch, 'utf8')
    expect(saved).toContain('+second')
    expect(saved).toContain('+untracked')
    expect(sprung()).toEqual([])
  })

  it('reaches no remote, so no ssh command, proxy or credential helper of the repository starts', async () => {
    const repo = hostileRepo('remote')
    plain(repo, 'remote', 'add', 'origin', 'ssh://git@example.invalid/acme/app.git')
    await expect(agentGit(repo, 'fetch', 'origin')).rejects.toThrow(/not allowed|transport/)
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

  it('finds a main checkout from its files and removes a stray worktree without running anything', async () => {
    const repo = hostileRepo('main')
    const stray = path.join(root, 'stray')
    plain(repo, 'worktree', 'add', '-q', '--detach', stray)
    reset()
    expect(mainCheckout(stray)).toBe(repo)
    expect(mainCheckout(repo)).toBeNull()
    expect(mainCheckout(root)).toBeNull()
    fs.writeFileSync(path.join(stray, 'left.txt'), 'uncommitted\n')
    expect(await removeLinkedWorktree(stray)).toBe(true)
    expect(fs.existsSync(stray)).toBe(false)
    expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toContain(stray)
    expect(sprung()).toEqual([])
  })
})
