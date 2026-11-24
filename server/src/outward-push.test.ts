import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Task } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tasks } from './db.js'
import { outsidePushes, outsideText, repoOf } from './outward-push.js'
import { permissionRules } from './store/permissions.js'

vi.mock('./github.js', () => ({
  viewerLogin: async () => Promise.resolve('me'),
  gh: async () => Promise.resolve('my-org\nAnother-Org\n'),
}))

const root = mkdtempSync(path.join(tmpdir(), 'seti-outward-'))

/** A clone in the agent's folder whose remotes are the ones given, on branch main. */
function repo(name: string, remotes: Record<string, string>, config: string[][] = []): string {
  const dir = path.join(root, name)
  mkdirSync(dir)
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like git.ts
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args])
  git('init', '-q', '-b', 'main')
  for (const [remote, url] of Object.entries(remotes)) {
    git('remote', 'add', remote, url)
  }
  for (const [key = '', value = ''] of config) {
    git('config', key, value)
  }
  return dir
}

await tasks.insert({ id: 'outward', title: 'Outward', repo_id: null, cwd: root, worktree: false, pr_urls: [] })
const stored = await tasks.get('outward')
if (stored === undefined) {
  throw new Error('the task was not stored')
}
const task: Task = { ...stored, repos: [{ id: 'r1', slug: 'given-owner/app', dir: root, worktree: false }] }

const asked = async (command: string, cwd = root) => (await outsidePushes(task, command, cwd)).map(outsideText)

afterEach(async () => {
  for (const rule of await permissionRules.list('outward')) {
    await permissionRules.remove('outward', rule.id)
  }
})

describe('pushes outside the user organisations', () => {
  it('never asks about an ordinary push to the agent own repositories, over https or ssh', async () => {
    const https = repo('https', { origin: 'https://github.com/my-org/tool.git' })
    const ssh = repo('ssh', { origin: 'git@github.com:another-org/tool.git' })
    const url = repo('ssh-url', { origin: 'ssh://git@github.com/me/notes' })
    const given = repo('given', { origin: 'https://github.com/given-owner/app' })
    for (const dir of [https, ssh, url, given]) {
      expect(await asked('git push', dir), dir).toEqual([])
      expect(await asked('git push -u origin feat/x', dir), dir).toEqual([])
    }
    expect(await asked('cd https && git push origin main')).toEqual([])
    expect(await asked('gh pr create -R my-org/tool --fill')).toEqual([])
  })

  it('asks before a push, fork, pull request or API write elsewhere, in words a phone shows', async () => {
    const theirs = repo('theirs', { origin: 'https://github.com/other/tool.git' })
    expect(await asked('git push origin main', theirs)).toEqual(['Push to other/tool, outside your organisations'])
    expect(await asked('git push git@gitlab.com:me/tool.git')).toEqual([
      'Push to gitlab.com/me/tool, outside your organisations',
    ])
    expect(await asked('gh repo fork other/tool')).toEqual(['Fork other/tool, outside your organisations'])
    expect(await asked('gh repo fork my-org/tool --org stranger')).toEqual([
      'Fork stranger, outside your organisations',
    ])
    expect(await asked('gh pr create --repo other/tool --fill')).toEqual([
      'Open a pull request on other/tool, outside your organisations',
    ])
    expect(await asked('gh api -X PATCH repos/other/tool/issues/1 -f state=closed')).toEqual([
      'Write to other/tool, outside your organisations',
    ])
  })

  it('follows the remote git picks and the rewrites the repository sets', async () => {
    const pushRemote = repo(
      'push-remote',
      { origin: 'https://github.com/me/tool', fork: 'https://github.com/x/tool' },
      [['branch.main.pushRemote', 'fork']],
    )
    expect(await asked('git push', pushRemote)).toEqual(['Push to x/tool, outside your organisations'])
    const rewritten = repo('rewritten', { origin: 'https://github.com/me/tool' }, [
      ['url.https://github.com/x/.pushInsteadOf', 'https://github.com/me/'],
    ])
    expect(await asked('git push', rewritten)).toEqual(['Push to x/tool, outside your organisations'])
  })

  it('asks when it cannot tell where a push goes', async () => {
    const plain = path.join(root, 'plain')
    mkdirSync(plain)
    expect(await asked('git push', plain)).toEqual(['Push to a repository Seti cannot tell is yours'])
    expect(await asked('cd "$X" && git push')).toEqual(['Push to a repository Seti cannot tell is yours'])
  })

  it("lets an owner through by the user's PushTo rule, and never asks about a local path", async () => {
    await permissionRules.add('outward', 'allow', 'PushTo(other)')
    expect(await asked('gh repo fork other/tool')).toEqual([])
    expect(await asked('git push ../backup main')).toEqual([])
  })

  it('reads owners from every remote form and keeps tokens out', () => {
    expect(repoOf('https://x-access-token:secret@github.com/acme/tool.git')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'tool',
    })
    expect(repoOf('acme/tool')).toEqual({ host: 'github.com', owner: 'acme', repo: 'tool' })
    expect(repoOf('/srv/git/tool.git')).toBeNull()
  })
})
