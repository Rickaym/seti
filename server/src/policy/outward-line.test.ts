import { describe, expect, it } from 'vitest'
import { outwardCalls, type Outward } from './outward.js'

const DIR = '/work/agent'
const HOME = '/home/me'
const REPO = `${HOME}/work/some-repo`
const MINE = `${HOME}/work/mine`

const push = (dir: string, remote: string | null = null): Outward[] => [{ action: 'push', where: { remote, dir } }]
const api = (repo: string): Outward[] => [{ action: 'api', where: { repo } }]
const read = (command: string) => outwardCalls(command, DIR, HOME)

describe('the folder and variables a line moves through before it pushes', () => {
  it.each<[string, Outward[]]>([
    ['cd ~/work/some-repo && git add src tests && git commit -q -m "fix: x" && git push -q', push(REPO)],
    ['cd ~/work/some-repo; git add f && git commit -q -m "fix(a): b" && git push -q origin HEAD', push(REPO, 'origin')],
    ['cd $HOME/work/some-repo && git push', push(REPO)],
    ['cd "${HOME}/work/some-repo" && git push', push(REPO)],
    ['cd && cd work/some-repo && git push', push(REPO)],
    ['cd ~ && cd work && cd ./some-repo/../some-repo && git push', push(REPO)],
    ['git -C ~/work/some-repo push origin main', push(REPO, 'origin')],
    ['pushd ~/work/some-repo >/dev/null; git push', push(REPO)],
    ['cd ~/work/some-repo && . /tmp/x/env.sh; uv run ruff check src; git push', push(REPO)],
    ['eval cd ~/work/mine; git push', push(MINE)],
    ['HOME=/elsewhere; cd ~/work && git push', push('/elsewhere/work')],
    ['cd /some/dir; R=owner/repo; gh api repos/$R/pulls -f title=x -f head=a -f base=b', api('owner/repo')],
    ['REPO="owner/repo"; gh api "repos/${REPO}/pulls" -f title=x', api('owner/repo')],
    ["export R='owner/repo'; gh api -X POST repos/$R/issues -f title=x", api('owner/repo')],
    ['cd ~/work/some-repo && R=owner/repo && gh api repos/$R/pulls -f title=x', api('owner/repo')],
    ['R=owner/repo; gh pr create -R $R --fill', [{ action: 'pr', where: { repo: 'owner/repo' } }]],
    ['R=owner/repo; gh repo fork $R', [{ action: 'fork', where: { repo: 'owner/repo' } }]],
  ])('follows %s', (command, expected) => {
    expect(read(command)).toEqual(expected)
  })

  it.each([
    'cd ~/work/some-repo && git diff origin/some/branch -- src/a.py | head -50',
    'cd ~/work/some-repo && git log --oneline origin/main..HEAD && git fetch origin',
    'cd ~/work/some-repo && . /tmp/x/env.sh; uv run ruff check src; uv run pytest -q 2>&1 | tail -5',
    "cd /some/dir; R=owner/repo; gh api repos/$R/pulls --jq '.[].number'",
    'R=$(mktemp); gh api repos/$R/pulls',
  ])('sends nothing for %s', (command) => {
    expect(read(command)).toEqual([])
  })

  it.each([
    'cd "$X" && git push',
    'cd $(mktemp -d) && git push',
    'cd `pwd`/x && git push',
    'cd ~other/x && git push',
    'cd ~/work/* && git push',
    'cd - && git push',
    'HOME=$(mktemp -d); cd ~ && git push',
    'HOME=/a; HOME=/b; cd ~ && git push',
    'HOME=~/x eval true; cd ~ && git push',
    'false && cd ~/work/mine; git push',
    'true || cd ~/work/mine && git push',
    'cd /a && cd ~/work/mine || git push',
    'cd /a && cd ~/work/mine; git push',
    'if true; then cd ~/work/mine; fi; git push',
    'for d in ~/work/mine; do cd $d && git push; done',
    'popd; git push',
  ])('cannot tell the folder of %s', (command) => {
    expect(read(command)[0]?.where).toEqual({ unknown: 'Seti cannot tell which folder it pushes from' })
  })

  it.each([
    'R=mine/repo; R=other/repo; gh api repos/$R/pulls -f x=1',
    'R=$(cat f); gh api repos/$R/pulls -f x=1',
    'R=owner/$X; gh api repos/$R/pulls -f x=1',
    'R+=x; gh api repos/$R/pulls -f x=1',
    'read R; gh api repos/$R/pulls -f x=1',
    'R=mine/repo; read -r R < f; gh api repos/$R/pulls -f x=1',
    'for R in mine/repo; do gh api repos/$R/pulls -f x=1; done',
    'R=mine/repo; unset R; gh api repos/$R/pulls -f x=1',
    'R=mine/repo; ((R=1)); gh api repos/$R/pulls -f x=1',
    'R=mine/repo; declare -n R=S; gh api repos/$R/pulls -f x=1',
    'R=mine/repo; eval R=other/repo; gh api repos/$R/pulls -f x=1',
    'R=mine/repo; : ${R:=other/repo}; gh api repos/$R/pulls -f x=1',
    'R=mine/repo; . ./env.sh; gh api repos/$R/pulls -f x=1',
    'R=mine/repo gh api repos/$R/pulls -f x=1',
    'gh api repos/$R/pulls -f x=1; R=mine/repo',
    'false && R=mine/repo; gh api repos/$R/pulls -f x=1',
    'if true; then R=mine/repo; fi; gh api repos/$R/pulls -f x=1',
    'R=mine/repo; gh pr create -R $R$S --fill',
    'gh repo fork $R',
    'gh repo fork --org $O',
    'git push $URL main',
  ])('cannot tell the destination of %s', (command) => {
    expect(read(command).some((call) => 'unknown' in call.where)).toBe(true)
  })

  it('keeps a subshell, a pipeline or a background cd out of the line', () => {
    expect(read('(cd ~/work/mine); git push')).toEqual(push(DIR))
    expect(read('cd ~/work/mine | true; git push')).toEqual(push(DIR))
    expect(read('cd ~/work/mine & git push')).toEqual(push(DIR))
    expect(read("bash -c 'cd ~/work/mine'; git push")).toEqual(push(DIR))
    expect(read('pushd ~/work/mine; popd; git push')).toEqual(push(DIR))
  })

  it('cannot read ~ without a home', () => {
    expect(outwardCalls('cd ~/work/some-repo && git push', DIR)[0]?.where).toHaveProperty('unknown')
  })
})
