import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import type { Task } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tasks } from './db.js'
import { outsidePushes, outsideText, repoOf } from './outward-push.js'
import { permissionRules } from './store/permissions.js'

const state = vi.hoisted(() => ({ signedIn: true, boxed: false }))

vi.mock('./github.js', () => ({
  viewerLogin: async () => (state.signedIn ? Promise.resolve('me') : Promise.reject(new Error('signed out'))),
  gh: async () => (state.signedIn ? Promise.resolve('my-org\nAnother-Org\n') : Promise.reject(new Error('signed out'))),
}))
vi.mock('./aws-access.js', () => ({ sandboxed: async () => Promise.resolve(state.boxed) }))

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

/** Clones in the agent home, one of the user's organisation and one outside it. */
const homes = () => {
  if (!existsSync(path.join(root, 'home-mine'))) {
    repo('home-mine', { origin: 'git@github.com:My-Org/tool.git' })
    repo('home-theirs', { origin: 'https://github.com/other/tool' })
  }
}

const asked = async (command: string, cwd = root) => (await outsidePushes(task, command, cwd)).map(outsideText)

afterEach(async () => {
  state.signedIn = true
  delete process.env.XDG_CONFIG_HOME
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
    expect(await asked('gh pr create -R github.com/my-org/tool --fill')).toEqual([])
    expect(await asked('gh repo fork', https)).toEqual([])
    const short = repo('short', { origin: 'github.com:me/tool' })
    expect(await asked('git push', short)).toEqual([])
    expect(await asked('git push https://github.com/me/notes main', https)).toEqual([])
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
    expect(await asked('git push https://github.com/me/tool main', rewritten)).toEqual([
      'Push to x/tool, outside your organisations',
    ])
    const upstream = repo('upstream', { origin: 'https://github.com/me/tool', upstream: 'https://github.com/x/tool' })
    expect(await asked('gh repo fork', upstream)).toEqual(['Fork x/tool, outside your organisations'])
    const modules = repo('modules', { origin: 'https://github.com/me/tool' }, [['submodule.recurse', 'true']])
    expect(await asked('git push', modules)).toEqual(['Push to a repository Seti cannot tell is yours'])
  })

  it('follows a remote changed by an earlier command, and asks about one changed in the same line', async () => {
    const changed = repo('changed', { origin: 'https://github.com/me/tool' })
    expect(await asked('git remote add x https://github.com/x/tool && git push x main', changed)).toEqual([
      'Push to a repository Seti cannot tell is yours',
    ])
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like git.ts
    execFileSync('git', ['-C', changed, 'remote', 'set-url', 'origin', 'https://github.com/x/tool'])
    expect(await asked('git push', changed)).toEqual(['Push to x/tool, outside your organisations'])
  })

  it("reads the agent's global git config, where a rewrite can send an own push elsewhere", async () => {
    const xdg = path.join(root, 'xdg')
    mkdirSync(path.join(xdg, 'git'), { recursive: true })
    writeFileSync(
      path.join(xdg, 'git', 'config'),
      '[url "https://github.com/x/"]\n\tpushInsteadOf = https://github.com/me/\n',
    )
    process.env.XDG_CONFIG_HOME = xdg
    const mine = repo('global', { origin: 'https://github.com/me/tool' })
    expect(await asked('git push', mine)).toEqual(['Push to x/tool, outside your organisations'])
  })

  it('fails closed to asking when gh is signed out', async () => {
    state.signedIn = false
    const https = path.join(root, 'https')
    expect(await asked('git push', https)).toEqual(['Push to my-org/tool, outside your organisations'])
    expect(await asked('gh pr create -R given-owner/app --fill')).toEqual([])
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
    expect(await asked('git push git@gitlab.com:other/tool.git')).toEqual([
      'Push to gitlab.com/other/tool, outside your organisations',
    ])
  })

  it.each<[string, string[]]>([
    ['cd ~/home-mine && git add src tests && git commit -q -m "fix: x" && git push -q', []],
    ['cd ~/home-mine; git add f && git commit -q -m x && git push -q origin HEAD', []],
    ['cd ~/home-mine && git diff origin/some/branch -- src | head', []],
    ['cd /some/dir; R=my-org/tool; gh api repos/$R/pulls -f title=x -f head=a -f base=b', []],
    ['cd ~/home-theirs && git push', ['Push to other/tool, outside your organisations']],
    ['R=other/tool; gh api repos/$R/pulls -f title=x', ['Write to other/tool, outside your organisations']],
    ['R=x; R=my-org/tool; gh api repos/$R/pulls -f title=x', ['Write to a repository Seti cannot tell is yours']],
    ['cd $(mktemp -d) && git push', ['Push to a repository Seti cannot tell is yours']],
    [
      "cd ~/home-mine && cat > /tmp/x/pr.md <<'EOF'\n| `a.tsx:1` | it's | Converted; kept |\nEOF\nx.sh | head; git push -u origin HEAD",
      [],
    ],
    [
      "cd ~/home-theirs && cat > /tmp/x/pr.md <<'EOF'\nit's\nEOF\ngit push",
      ['Push to other/tool, outside your organisations'],
    ],
    ['R=my-org/tool; for p in 1 2; do gh api -X POST repos/$R/pulls/$p/comments/$c/replies -f body=x; done', []],
  ])('reads ~ as the agent home and literal variables in %s', async (command, expected) => {
    homes()
    const home = vi.spyOn(os, 'homedir').mockReturnValue(root)
    expect(await asked(command, '/nowhere')).toEqual(expected)
    home.mockRestore()
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
