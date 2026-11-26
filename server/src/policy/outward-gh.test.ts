import { describe, expect, it } from 'vitest'
import { outwardCalls, type Outward, type OutwardAction } from './outward.js'

const DIR = '/work/agent'
const HOME = '/home/me'

const read = (command: string) => outwardCalls(command, DIR, HOME)
const onRepo = (action: OutwardAction, repo: string): Outward => ({ action, where: { repo } })
const inFolder = (action: OutwardAction, dir = DIR): Outward => ({ action, where: { remote: '*', dir } })

/** Each write, as typed, with its action and a number, a URL or nothing naming the item. */
const WRITES: [string, OutwardAction, string][] = [
  ['pr comment 12 --body hi', 'pr comment', 'pull/12'],
  ['pr comment -b hi', 'pr comment', ''],
  ['pr review 12 --approve', 'pr review', 'pull/12'],
  ['pr review -r -b "needs work" 12', 'pr review', 'pull/12'],
  ['pr review --comment -b x', 'pr review', ''],
  ['pr merge 12 --squash --delete-branch', 'pr merge', 'pull/12'],
  ['pr merge -m -t subject 12', 'pr merge', 'pull/12'],
  ['pr close 12 -c done', 'pr close', 'pull/12'],
  ['pr reopen 12', 'pr reopen', 'pull/12'],
  ['pr ready 12', 'pr ready', 'pull/12'],
  ['pr edit 12 --add-label bug -t title', 'pr edit', 'pull/12'],
  ['pr lock 12 -r spam', 'pr lock', 'pull/12'],
  ['pr unlock 12', 'pr unlock', 'pull/12'],
  ['pr update-branch 12 --rebase', 'pr update-branch', 'pull/12'],
  ['pr revert 12 -t x', 'pr revert', 'pull/12'],
  ['issue create -t x -b y -l bug', 'issue create', ''],
  ['issue new -t x', 'issue create', ''],
  ['issue comment 3 --body-file /tmp/x.md', 'issue comment', 'issues/3'],
  ['issue close 3 -r "not planned"', 'issue close', 'issues/3'],
  ['issue reopen 3', 'issue reopen', 'issues/3'],
  ['issue edit 3 --add-assignee @me', 'issue edit', 'issues/3'],
  ['issue delete 3 --yes', 'issue delete', 'issues/3'],
  ['issue lock 3', 'issue lock', 'issues/3'],
  ['issue unlock 3', 'issue unlock', 'issues/3'],
  ['issue pin 3', 'issue pin', 'issues/3'],
  ['issue unpin 3', 'issue unpin', 'issues/3'],
  ['issue develop 3 -n topic', 'issue develop', 'issues/3'],
  ['release create v1 ./dist/a.tgz --notes x', 'release create', ''],
  ['release new v1', 'release create', ''],
  ['release edit v1 --draft=false', 'release edit', ''],
  ['release delete v1 --yes', 'release delete', ''],
  ['release upload v1 a.tgz --clobber', 'release upload', ''],
  ['release delete-asset v1 a.tgz', 'release delete-asset', ''],
]

const withUrl = (command: string, item: string) =>
  item === '' ? command : command.replace(/ \d+(?= |$)/, ` https://github.com/other/tool/${item}`)

describe("gh writes to a repository's pull requests, issues and releases", () => {
  it.each(WRITES)('reads gh %s in the folder, with -R and with a URL', (command, action, item) => {
    expect(read(`gh ${command}`), command).toEqual([inFolder(action)])
    expect(read(`gh ${command} -R other/tool`), command).toEqual([onRepo(action, 'other/tool')])
    expect(read(`gh ${command} --repo=github.com/my-org/tool`), command).toEqual([
      onRepo(action, 'https://github.com/my-org/tool'),
    ])
    if (item !== '') {
      expect(read(`gh ${withUrl(command, item)}`), command).toEqual([onRepo(action, 'https://github.com/other/tool')])
    }
  })

  it('takes the URL over -R, and both a URL and the folder when an edit names both', () => {
    expect(read('gh pr comment https://github.com/other/tool/pull/3 -R my-org/tool -b x')).toEqual([
      onRepo('pr comment', 'https://github.com/other/tool'),
    ])
    expect(read('gh issue edit https://github.com/other/tool/issues/3 4 --add-label x')).toEqual([
      onRepo('issue edit', 'https://github.com/other/tool'),
      inFolder('issue edit'),
    ])
    expect(read('gh pr review https://git.example.com/a/b/pull/3/files --approve')).toEqual([
      onRepo('pr review', 'https://git.example.com/a/b'),
    ])
  })

  it('reads where an issue moves to and the repository a linked branch goes to', () => {
    expect(read('gh issue transfer 3 other/elsewhere -R my-org/tool')).toEqual([
      onRepo('issue transfer', 'my-org/tool'),
      onRepo('issue transfer', 'other/elsewhere'),
    ])
    expect(read('gh issue develop 3 --branch-repo other/fork')).toEqual([
      inFolder('issue develop'),
      onRepo('issue develop', 'other/fork'),
    ])
    expect(read('gh issue develop --list 3')).toEqual([])
  })

  it('reads a computed number as a number, and a computed owner, repository or URL as unknown', () => {
    expect(read('gh pr comment $N -R other/tool -b x')).toEqual([onRepo('pr comment', 'other/tool')])
    expect(read('for n in 1 2; do gh pr merge "$n" --squash; done')).toEqual([inFolder('pr merge')])
    expect(read('gh pr review https://github.com/other/tool/pull/$N --approve')).toEqual([
      onRepo('pr review', 'https://github.com/other/tool'),
    ])
    expect(read('N=$(gh pr list -q .[0].number); gh pr close "$N" -R my-org/tool')).toEqual([
      onRepo('pr close', 'my-org/tool'),
    ])
    for (const command of [
      'gh pr comment https://github.com/$OWNER/tool/pull/3 -b x',
      'gh pr comment 3 -R "$REPO" -b x',
      'gh issue comment 3 -R other/$NAME -b x',
      'gh pr comment "$URL/pull/3" -b x',
      'gh pr review https://$HOST/other/tool/pull/3 --approve',
      'gh issue create -R other/* -t x',
    ]) {
      expect(read(command)[0]?.where, command).toHaveProperty('unknown')
    }
    expect(read('U=https://github.com/other/tool/pull/3; gh pr comment $U -b x')).toEqual([
      onRepo('pr comment', 'https://github.com/other/tool'),
    ])
  })

  it('reads bodies as data, follows cd, and leaves calls unknown under GH_REPO or changed remotes', () => {
    const body = "cat > /tmp/b.md <<'EOF'\nSee https://github.com/other/tool/pull/9 and run gh pr merge 9.\nEOF\n"
    expect(read(`cd ~/work/tool && ${body}gh pr comment 4 -F /tmp/b.md`)).toEqual([
      inFolder('pr comment', `${HOME}/work/tool`),
    ])
    expect(read('gh pr comment 4 --body https://github.com/my-org/tool/pull/1')).toEqual([inFolder('pr comment')])
    expect(read('GH_REPO=my-org/tool gh pr comment 4 -b x')[0]?.where).toHaveProperty('unknown')
    expect(read('git remote add up https://github.com/x/y && gh pr merge 4')[0]?.where).toHaveProperty('unknown')
    expect(read('cd "$D" && gh pr comment 4 -b x')[0]?.where).toHaveProperty('unknown')
  })

  it('leaves reads alone', () => {
    for (const command of [
      'gh pr view 12 --comments',
      'gh pr list -R other/tool',
      'gh pr checks 12',
      'gh pr diff https://github.com/other/tool/pull/3',
      'gh pr status',
      'gh pr checkout 12',
      'gh issue view 3 -R other/tool',
      'gh issue list --state open',
      'gh issue status',
      'gh release view v1 -R other/tool',
      'gh release list',
      'gh release download v1 -R other/tool',
      'echo gh pr comment 3 -b x',
    ]) {
      expect(read(command), command).toEqual([])
    }
  })
})
