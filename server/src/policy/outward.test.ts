import { describe, expect, it } from 'vitest'
import { outwardCalls } from './outward.js'

const DIR = '/work/agent'

describe('what a shell line sends to a code host', () => {
  it('reads a push to the default remote, a named one and one named by URL', () => {
    expect(outwardCalls('git push', DIR)).toEqual([{ action: 'push', where: { remote: null, dir: DIR } }])
    expect(outwardCalls('git push -u origin feat/x', DIR)).toEqual([
      { action: 'push', where: { remote: 'origin', dir: DIR } },
    ])
    expect(outwardCalls('git push --force-with-lease -o ci.skip upstream HEAD', DIR)).toEqual([
      { action: 'push', where: { remote: 'upstream', dir: DIR } },
    ])
    expect(outwardCalls('git push https://github.com/other/tool.git HEAD:main', DIR)).toEqual([
      { action: 'push', where: { repo: 'https://github.com/other/tool.git' } },
    ])
    expect(outwardCalls('git push --repo=git@github.com:other/tool.git', DIR)).toEqual([
      { action: 'push', where: { repo: 'git@github.com:other/tool.git' } },
    ])
  })

  it('follows cd, git -C and the wrappers and scripts the shell reader sees through', () => {
    const inRepo = [{ action: 'push', where: { remote: 'origin', dir: `${DIR}/repo` } }]
    expect(outwardCalls('cd repo && git push origin main', DIR)).toEqual(inRepo)
    expect(outwardCalls('git -C repo push origin main', DIR)).toEqual(inRepo)
    expect(outwardCalls("bash -c 'cd repo && timeout 60 git push origin main'", DIR)).toEqual(inRepo)
    expect(outwardCalls('cd repo; nohup env GIT_TRACE=1 git push origin main', DIR)).toEqual(inRepo)
    expect(outwardCalls('echo $(git -C repo push origin main)', DIR)).toEqual(inRepo)
  })

  it('cannot follow a folder or config the shell computes, and says so', () => {
    expect(outwardCalls('cd "$REPO" && git push', DIR)[0]?.where).toHaveProperty('unknown')
    expect(outwardCalls('git -c url.x.pushInsteadOf=y push', DIR)[0]?.where).toHaveProperty('unknown')
    expect(outwardCalls('git --git-dir=/elsewhere push', DIR)[0]?.where).toHaveProperty('unknown')
  })

  it('reads forks, pull requests on a named repository and API writes', () => {
    expect(outwardCalls('gh repo fork other/tool --clone', DIR)).toEqual([
      { action: 'fork', where: { repo: 'other/tool' } },
    ])
    expect(outwardCalls('gh repo fork --org elsewhere', DIR)).toEqual([
      { action: 'fork', where: { remote: 'origin', dir: DIR } },
      { action: 'fork', where: { owner: 'elsewhere' } },
    ])
    expect(outwardCalls('gh pr create -R other/tool --fill', DIR)).toEqual([
      { action: 'pr', where: { repo: 'other/tool' } },
    ])
    expect(outwardCalls('gh api -X POST repos/other/tool/issues -f title=x', DIR)).toEqual([
      { action: 'api', where: { repo: 'other/tool' } },
    ])
    expect(outwardCalls('gh api /repos/other/tool/pulls -f title=x', DIR)).toEqual([
      { action: 'api', where: { repo: 'other/tool' } },
    ])
    expect(outwardCalls('gh api repos/{owner}/{repo}/labels -f name=x', DIR)).toEqual([
      { action: 'api', where: { remote: 'origin', dir: DIR } },
    ])
  })

  it('leaves reads and other commands alone', () => {
    for (const command of [
      'git status',
      'git pull origin main',
      'git log --oneline',
      'gh pr create --fill',
      'gh pr view 12',
      'gh api repos/other/tool/pulls',
      'gh api -X GET repos/other/tool/issues -f state=open',
      'echo git push',
    ]) {
      expect(outwardCalls(command, DIR), command).toEqual([])
    }
  })
})
