import { describe, expect, it } from 'vitest'
import { prMentions, type PrMention } from './pr-mentions.js'

const read = (command: string) => prMentions(command, '/work/agent', '/home/me')
const at = (owner: string, repo: string, number: number): PrMention => ({ owner, repo, number })
const here = (number: number, dir = '/work/agent'): PrMention => ({ dir, number })
const URL = 'https://github.com/acme/tool/pull/2136'

describe('pull requests a command names', () => {
  it.each<[string, PrMention[]]>([
    [
      'gh pr merge 2136 -R acme/tool --merge 2>&1 | tail -2; gh pr view 2137 -R acme/tool',
      [at('acme', 'tool', 2136), at('acme', 'tool', 2137)],
    ],
    ['gh pr view 12 --repo acme/tool', [at('acme', 'tool', 12)]],
    ['gh pr view 12 --repo=acme/tool --json title', [at('acme', 'tool', 12)]],
    ['gh pr close 3 -R github.com/acme/tool -c "done here"', [at('acme', 'tool', 3)]],
    ['gh pr reopen 4 -R https://github.com/acme/tool', [at('acme', 'tool', 4)]],
    ['gh pr ready 5 -R acme/tool', [at('acme', 'tool', 5)]],
    ['gh pr comment -b "see 99" 6 -R acme/tool', [at('acme', 'tool', 6)]],
    ['gh pr review 7 --approve -R acme/tool', [at('acme', 'tool', 7)]],
    ['gh pr checks 8 -R acme/tool --watch -i 10', [at('acme', 'tool', 8)]],
    ['gh pr edit 9 -m v2 -R acme/tool', [at('acme', 'tool', 9)]],
    ['gh pr edit -m v2 9 -R acme/tool', [at('acme', 'tool', 9)]],
    ['gh pr diff 10 -R acme/tool --color never', [at('acme', 'tool', 10)]],
    ['gh pr merge --squash --auto 11 -R acme/tool', [at('acme', 'tool', 11)]],
    ['gh pr view -c 13 -R acme/tool', [at('acme', 'tool', 13)]],
    ['N=14; gh pr view "$N" -R acme/tool', [at('acme', 'tool', 14)]],
  ])('reads %s', (command, expected) => {
    expect(read(command)).toEqual(expected)
  })

  it.each<[string, PrMention[]]>([
    [`gh pr view ${URL}`, [at('acme', 'tool', 2136)]],
    [`gh pr merge ${URL} --squash`, [at('acme', 'tool', 2136)]],
    [`curl -s ${URL}/files`, [at('acme', 'tool', 2136)]],
    [`open "${URL}#discussion_r1"`, [at('acme', 'tool', 2136)]],
    ['gh api repos/acme/tool/pulls/21', [at('acme', 'tool', 21)]],
    ['gh api /repos/acme/tool/pulls/22/reviews --jq ".[].state"', [at('acme', 'tool', 22)]],
    ['gh api -X PUT repos/acme/tool/pulls/23/merge -f merge_method=squash', [at('acme', 'tool', 23)]],
    ['R=acme/tool; gh api repos/$R/pulls/24', [at('acme', 'tool', 24)]],
  ])('reads a URL or an API path in %s', (command, expected) => {
    expect(read(command)).toEqual(expected)
  })

  it.each<[string, PrMention[]]>([
    ['gh pr merge 31 --squash', [here(31)]],
    ['cd ../tool && gh pr view 32', [here(32, '/work/tool')]],
    ['git -C x status; cd /src/tool; gh pr checks 33', [here(33, '/src/tool')]],
    ['gh api repos/{owner}/{repo}/pulls/34', [here(34)]],
  ])('reads %s in the folder the walker resolves', (command, expected) => {
    expect(read(command)).toEqual(expected)
  })

  it.each([
    'gh pr view $PR -R acme/tool',
    'gh pr view 12 -R $REPO',
    'gh pr view 12 -R acme/$(cat name)',
    'gh pr view 12 -R `cat repo`',
    'gh api repos/$O/tool/pulls/1',
    'gh api repos/acme/tool/pulls/$N',
    'cd "$DIR" && gh pr view 40',
    'cd $(mktemp -d) && gh pr view 41',
    'GH_REPO=acme/tool gh pr view 42',
    'git remote set-url origin https://github.com/other/x && gh pr merge 43',
    'gh pr view feature-branch -R acme/tool',
    'gh pr view',
    'gh pr create -R acme/tool --title x',
    'gh pr list -R acme/tool',
    'gh issue view 12 -R acme/tool',
    'echo 12',
  ])('names no PR in %s', (command) => {
    expect(read(command)).toEqual([])
  })

  it.each([
    'gh pr view 12 -R gitlab.com/acme/tool',
    'gh pr view 12 -R https://ghe.example.com/acme/tool',
    'gh api --hostname ghe.example.com repos/acme/tool/pulls/12',
    'curl https://gitlab.com/acme/tool/pull/12',
    'curl https://ghe.example.com/acme/tool/pull/12',
    'GH_HOST=ghe.example.com gh pr view 12 -R acme/tool',
  ])('names no PR on another host in %s', (command) => {
    expect(read(command)).toEqual([])
  })

  it('reads every PR, each once, beyond three', () => {
    const command = [1, 2, 3, 4, 5, 2].map((n) => `gh pr view ${String(n)} -R acme/tool`).join('; ')
    expect(read(command)).toEqual([1, 2, 3, 4, 5].map((n) => at('acme', 'tool', n)))
  })

  it('reads no folder PR when the folder is not known', () => {
    expect(prMentions('gh pr view 5', null)).toEqual([])
  })
})
