import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { jailCommand, type JailedGit } from './git-jail.js'
import { agentGit, saveUncommitted } from './git.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seti-git-jail-')))
const secret = path.join(root, 'secret.txt')
fs.writeFileSync(secret, 'host secret\n')
const home = process.env.HOME

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  process.env.HOME = home
})

function plain(cwd: string, ...args: string[]): string {
  const identity = ['-c', 'user.name=Seti Test', '-c', 'user.email=test@seti.invalid']
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like git.ts
  return execFileSync('git', [...identity, '-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
}

/** A repository whose clean filter runs `script` from inside it, as an agent could set one up. */
function filteredRepo(name: string, script: string): string {
  const repo = path.join(root, name)
  fs.mkdirSync(repo)
  plain(repo, 'init', '-q', '--initial-branch=main')
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'first\n')
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=any-name\n')
  plain(repo, 'add', '.')
  plain(repo, 'commit', '-qm', 'seed')
  const filter = path.join(repo, '.git', 'filter.sh')
  fs.writeFileSync(filter, `#!/bin/sh\n${script}\ncat\n`, { mode: 0o755 })
  plain(repo, 'config', 'filter.any-name.clean', filter)
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'FIRST\n')
  return repo
}

const run = (cwd: string, write: boolean): JailedGit => ({
  cwd,
  argv: ['status'],
  write,
  files: [],
  folders: [],
  env: {},
})

describe('the git jail', () => {
  it('mounts the system folders and the repository only, read-only unless the command writes', () => {
    const repo = filteredRepo('mounts', 'true')
    const read = jailCommand(run(repo, false), '/usr/bin/bwrap', '/usr/bin/git')
    expect(read.args).toEqual(expect.arrayContaining(['--unshare-net', '--unshare-user', '--die-with-parent']))
    const binds = read.args.flatMap((arg, i) => (arg.endsWith('bind') ? [`${arg} ${read.args[i + 1] ?? ''}`] : []))
    const system = /^--ro-bind \/(usr|etc|bin|sbin|lib\w*)$/
    expect(binds.filter((bind) => !system.test(bind))).toEqual([`--ro-bind ${repo}`])
    expect(jailCommand(run(repo, true), '/usr/bin/bwrap', '/usr/bin/git').args).toContain('--bind')
    expect(Object.keys(read.env).filter((name) => !/^(GIT_\w+|PATH|HOME|LANG)$/.test(name))).toEqual([])
  })

  it('refuses a repository that holds the home folder', () => {
    const repo = filteredRepo('home', 'true')
    process.env.HOME = path.join(repo, 'me')
    expect(() => jailCommand(run(repo, false), '/usr/bin/bwrap', '/usr/bin/git')).toThrow(/holds/)
  })

  it('lets a filter that runs in a write see neither host files nor the server environment', async () => {
    process.env.SETI_JAIL_TEST_VALUE = 'server-only'
    const repo = filteredRepo(
      'confined',
      'touch "$PWD/.git/ran"; cat "$SECRET_FILE" > "$PWD/.git/leak"; env > "$PWD/.git/env"',
    )
    const script = path.join(repo, '.git', 'filter.sh')
    fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace('$SECRET_FILE', secret))
    const patches = fs.mkdtempSync(path.join(root, 'patches-'))
    await saveUncommitted(repo, path.join(patches, 'confined.patch'))
    expect(fs.existsSync(path.join(repo, '.git', 'ran'))).toBe(true)
    expect(fs.readFileSync(path.join(repo, '.git', 'leak'), 'utf8')).toBe('')
    expect(fs.readFileSync(path.join(repo, '.git', 'env'), 'utf8')).not.toContain('server-only')
  })

  it('keeps a filter that runs in a read from writing even the repository', async () => {
    const repo = filteredRepo('read-only', 'touch "$PWD/.git/wrote"')
    expect(await agentGit(repo, 'status', '--porcelain')).toContain('notes.txt')
    expect(fs.existsSync(path.join(repo, '.git', 'wrote'))).toBe(false)
  })

  it('reads no repository that a forged .git file names, and says when a folder is in none', async () => {
    const foreign = filteredRepo('foreign', 'true')
    const forged = path.join(root, 'forged')
    fs.mkdirSync(forged)
    fs.writeFileSync(path.join(forged, '.git'), `gitdir: ${path.join(foreign, '.git')}\n`)
    await expect(agentGit(forged, 'status', '--porcelain')).rejects.toThrow()
    const outside = fs.mkdtempSync(path.join(root, 'outside-'))
    await expect(agentGit(outside, 'status')).rejects.toThrow(/not a git repository/)
  })
})
