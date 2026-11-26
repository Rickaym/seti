import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Task } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tasks } from './db.js'
import { outsidePushes, outsideText } from './outward-push.js'
import { pushReason } from './push-asks.js'
import { permissionRules } from './store/permissions.js'

vi.mock('./github.js', () => ({
  viewerLogin: async () => Promise.resolve('me'),
  gh: async () => Promise.resolve('my-org\n'),
}))
vi.mock('./aws-access.js', () => ({ sandboxed: async () => Promise.resolve(false) }))

const root = mkdtempSync(path.join(tmpdir(), 'seti-pr-writes-'))

/** A clone in the agent's folder whose remotes are the ones given. */
function repo(name: string, remotes: Record<string, string>): string {
  const dir = path.join(root, name)
  mkdirSync(dir)
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like git.ts
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args])
  git('init', '-q', '-b', 'main')
  for (const [remote, url] of Object.entries(remotes)) {
    git('remote', 'add', remote, url)
  }
  return dir
}

await tasks.insert({ id: 'pr-writes', title: 'PR writes', repo_id: null, cwd: root, worktree: false, pr_urls: [] })
const stored = await tasks.get('pr-writes')
if (stored === undefined) {
  throw new Error('the task was not stored')
}
const task: Task = { ...stored, repos: [] }

const mine = repo('mine', { origin: 'git@github.com:my-org/tool.git' })
const theirs = repo('theirs', { origin: 'https://github.com/other/tool' })
const forked = repo('forked', { origin: 'https://github.com/me/tool', upstream: 'https://github.com/other/tool' })

const asked = async (command: string, cwd = root) => (await outsidePushes(task, command, cwd)).map(outsideText)

afterEach(async () => {
  for (const rule of await permissionRules.list('pr-writes')) {
    await permissionRules.remove('pr-writes', rule.id)
  }
})

describe("writes to a repository's pull requests, issues and releases", () => {
  it.each<[string, string]>([
    ['gh pr comment 3 -b x', 'Comment on other/tool, outside your organisations'],
    ['gh pr review 3 --approve', 'Review other/tool, outside your organisations'],
    ['gh pr review 3 --request-changes -b x', 'Review other/tool, outside your organisations'],
    ['gh pr merge 3 --squash', 'Merge into other/tool, outside your organisations'],
    ['gh pr close 3', 'Close a pull request on other/tool, outside your organisations'],
    ['gh pr edit 3 --add-label x', 'Edit a pull request on other/tool, outside your organisations'],
    ['gh issue comment 5 -b x', 'Comment on other/tool, outside your organisations'],
    ['gh issue create -t x -b y', 'Open an issue on other/tool, outside your organisations'],
    ['gh issue close 5', 'Close an issue on other/tool, outside your organisations'],
    ['gh release create v1 --notes x', 'Publish a release on other/tool, outside your organisations'],
  ])('asks before %s outside, and never in an own repository', async (command, reason) => {
    expect(await asked(command, theirs)).toEqual([reason])
    expect(await asked(`${command} -R other/tool`, mine)).toEqual([reason])
    expect(await asked(command, mine)).toEqual([])
    expect(await asked(`${command} -R my-org/tool`, theirs)).toEqual([])
    expect(await asked(`${command} --repo me/notes`)).toEqual([])
  })

  it('reads the repository of a URL, over -R and the folder', async () => {
    expect(await asked('gh pr comment https://github.com/other/tool/pull/3 -b x', mine)).toEqual([
      'Comment on other/tool, outside your organisations',
    ])
    expect(await asked('gh pr review https://github.com/my-org/tool/pull/3 --approve', theirs)).toEqual([])
    expect(await asked('gh issue comment https://github.com/My-Org/tool/issues/3 -R other/tool -b x')).toEqual([])
    expect(await asked('gh pr merge https://git.example.com/me/tool/pull/3')).toEqual([
      'Merge into git.example.com/me/tool, outside your organisations',
    ])
  })

  it('checks every remote gh may pick, since it prefers upstream', async () => {
    expect(await asked('gh pr comment 3 -b x', forked)).toEqual(['Comment on other/tool, outside your organisations'])
    expect(await asked('gh pr comment 3 -b x -R me/tool', forked)).toEqual([])
  })

  it('asks in the cannot-tell words for a computed owner, repository or URL, not a computed number', async () => {
    const unknown = 'Comment on a repository Seti cannot tell is yours'
    expect(await asked('gh pr comment 3 -R "$REPO" -b x', mine)).toEqual([unknown])
    expect(await asked('gh pr comment https://github.com/$O/tool/pull/3 -b x', mine)).toEqual([unknown])
    expect(await asked('gh pr comment "$URL/pull/3" -b x', mine)).toEqual([unknown])
    expect(await asked('cd "$D" && gh pr comment 3 -b x')).toEqual([unknown])
    expect(await asked('gh pr comment "$N" -R my-org/tool -b x', theirs)).toEqual([])
    expect(await asked('gh pr comment https://github.com/my-org/tool/pull/$N -b x', theirs)).toEqual([])
    expect(await asked('gh pr comment "$N" -b x', mine)).toEqual([])
  })

  it('reads a heredoc body as data', async () => {
    const body = "cat > /tmp/b.md <<'EOF'\nApproved. See https://github.com/other/tool/pull/9; gh pr merge 9.\nEOF\n"
    expect(await asked(`cd mine && ${body}gh pr review 4 --approve -F /tmp/b.md`)).toEqual([])
    expect(await asked(`cd theirs && ${body}gh pr review 4 --approve -F /tmp/b.md`)).toEqual([
      'Review other/tool, outside your organisations',
    ])
  })

  it("lets an owner through by the user's PushTo rule, and joins one reason per write", async () => {
    const line = 'gh pr comment 3 -b x -R other/tool && gh pr merge 3 -R other/tool && gh issue close 1 -R else/tool'
    expect(pushReason(await outsidePushes(task, line, mine))).toBe(
      'Comment on other/tool, outside your organisations; Merge into other/tool, outside your organisations; ' +
        'Close an issue on else/tool, outside your organisations',
    )
    await permissionRules.add('pr-writes', 'allow', 'PushTo(other)')
    expect(await asked(line, mine)).toEqual(['Close an issue on else/tool, outside your organisations'])
    expect(await asked('gh pr comment 3 -b x', forked)).toEqual([])
  })

  it('never asks about reads', async () => {
    for (const command of ['gh pr view 3 --comments', 'gh pr checks 3', 'gh issue list', 'gh release view v1']) {
      expect(await asked(command, theirs), command).toEqual([])
    }
  })
})
