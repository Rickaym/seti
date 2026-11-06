import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { treeReader, withGitSource } from './read-git.js'

const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }

function git(dir: string, ...args: string[]): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like the server
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    env: ENV,
  }).toString()
}

/** A repository with one commit holding the files, plus a symlink or submodule entry if asked. */
function repo(
  files: Record<string, string>,
  extra: 'symlink' | 'submodule' | null = null,
): { gitDir: string; commit: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-git-'))
  git(dir, 'init', '-q')
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body)
  }
  if (extra === 'symlink') {
    fs.symlinkSync('/etc/passwd', path.join(dir, 'logic.js'))
  }
  git(dir, 'add', '-A')
  if (extra === 'submodule') {
    git(dir, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},vendor`)
  }
  git(dir, 'commit', '-q', '-m', 'mod')
  return { gitDir: path.join(dir, '.git'), commit: git(dir, 'rev-parse', 'HEAD').trim() }
}

describe('git sources', () => {
  it('reads files of the commit from the object store, and nothing it was not asked for', async () => {
    const { gitDir, commit } = repo({ 'seti-mod.json': '{"id":"linear"}', 'README.md': 'Hello' })
    const source = await treeReader(gitDir, commit)
    expect(source.ref).toBe(commit)
    expect((await source.read('seti-mod.json', 1024))?.toString()).toBe('{"id":"linear"}')
    expect(await source.read('missing.js', 1024)).toBeNull()
    await expect(source.read('README.md', 2)).rejects.toThrow(/README.md is over/)
  })

  it('refuses a tree with a symlink or a submodule', async () => {
    const linked = repo({ 'seti-mod.json': '{}' }, 'symlink')
    await expect(treeReader(linked.gitDir, linked.commit)).rejects.toThrow(/logic.js is a symlink/)
    const sub = repo({ 'seti-mod.json': '{}' }, 'submodule')
    await expect(treeReader(sub.gitDir, sub.commit)).rejects.toThrow(/vendor is a submodule/)
  })

  it('fetches over https only, so a file or ssh URL never reaches git', async () => {
    const { gitDir } = repo({ 'seti-mod.json': '{}' })
    await expect(withGitSource(`file://${gitDir}`, 'HEAD', async () => Promise.resolve(1))).rejects.toThrow(
      /https only/,
    )
  })
})
