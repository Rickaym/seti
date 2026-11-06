import { describe, expect, it } from 'vitest'
import { pushedHead, pushesOf, pushOutput, pushTargets, transcriptEvidence } from './pr-evidence.js'
import type { StoredRow } from './store/pr-discovery.js'

const PR = 'https://github.com/globex/voice-bot/pull/1460'

const call = (id: string, name: string, input: unknown, parent: string | null = null): StoredRow => ({
  kind: 'sdk',
  payload: JSON.stringify({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { content: [{ type: 'tool_use', id, name, input }] },
  }),
})
const bash = (id: string, command: string, parent: string | null = null) => call(id, 'Bash', { command }, parent)
const result = (id: string, content: string): StoredRow => ({
  kind: 'sdk',
  payload: JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } }),
})

describe('pushTargets', () => {
  it.each([
    ['git push -u origin fix/x', ['fix/x'], false],
    [
      'cd ~/wt && git switch -q -c ci/gates && git push -q -u origin ci/gates 2>&1 | grep -v remote',
      ['ci/gates'],
      false,
    ],
    ['git -C /tmp/wt push origin HEAD:refs/heads/fix/y', ['fix/y'], false],
    ['git push --force-with-lease origin +fix/z', ['fix/z'], false],
    ['git push -o ci.skip origin fix/a fix/b > /tmp/log', ['fix/a', 'fix/b'], false],
    ['git push', [], true],
    ['git push -u origin HEAD', [], true],
    ['git push origin "$BRANCH"', [], true],
  ])('%s', (command, named, unnamed) => {
    expect(pushTargets(command)).toEqual({ named, unnamed })
  })

  it('ignores commands that push nothing to a branch', () => {
    expect(pushTargets('gh pr view 1460 && git log --oneline -3')).toBeNull()
    expect(pushTargets('git push origin --delete fix/old')).toBeNull()
    expect(pushTargets('git push --tags')).toBeNull()
    expect(pushTargets('echo "remember to git push later"')).toBeNull()
  })
})

describe('pushOutput', () => {
  it('reads the remote and every updated or rejected ref', () => {
    const out = pushOutput(
      [
        'To github.com:globex/voice-bot.git',
        ' * [new branch]      perf/core-tests -> perf/core-tests',
        '   1a2b3c4..5d6e7f8  fix/x -> fix/x',
        ' + 1a2b3c4...5d6e7f8 fix/y -> fix/y (forced update)',
        ' ! [rejected]        fix/z -> fix/z (non-fast-forward)',
        'error: failed to push some refs to github.com:globex/voice-bot.git',
      ].join('\n'),
    )
    const repo = 'globex/voice-bot'
    expect(out.pushed).toEqual([
      { branch: 'perf/core-tests', repo },
      { branch: 'fix/x', repo },
      { branch: 'fix/y', repo },
    ])
    expect(out.rejected).toEqual(new Set(['fix/z']))
    expect(out.failed).toBe(true)
  })

  it('reads only the push report, not what a fetch in the same command printed', () => {
    const out = pushOutput(
      [
        'From github.com:a/b',
        ' * branch            dev        -> FETCH_HEAD',
        '   1a2b3c4..5d6e7f8  dev        -> origin/dev',
        'To github.com:a/b.git',
        ' * [new branch]      fix/x -> fix/x',
      ].join('\n'),
    )
    expect(out.pushed).toEqual([{ branch: 'fix/x', repo: 'a/b' }])
  })

  it('keeps the remote unknown when it is not on GitHub', () => {
    expect(pushOutput('To /srv/git/app.git\n * [new branch]      a -> a').pushed).toEqual([{ branch: 'a', repo: null }])
  })
})

describe('pushesOf', () => {
  it('takes branches a quiet push names, and drops them when the push failed', () => {
    expect(pushesOf('git push -q -u origin fix/x', '')).toEqual([{ branch: 'fix/x', repo: null }])
    expect(pushesOf('git push origin fix/x', 'fatal: could not read Username')).toEqual([])
  })

  it('takes the branch a bare push printed', () => {
    const out = 'To https://github.com/Octocat/seti.git\n   1a2b3c4..5d6e7f8  fix/x -> fix/x\n'
    expect(pushesOf('git push', out)).toEqual([{ branch: 'fix/x', repo: 'Octocat/seti' }])
  })

  it('finds nothing in commands that are no push', () => {
    expect(pushesOf('git log', 'To github.com:a/b.git\n * [new branch] a -> a')).toEqual([])
  })
})

describe('pushedHead', () => {
  const head = { url: PR, head_ref: 'perf/core-tests', head_repo: 'globex/voice-bot' }

  it('matches the head branch, in the head repo when the push named one', () => {
    expect(pushedHead(head, [{ branch: 'perf/core-tests', repo: null }])).toBe(true)
    expect(pushedHead(head, [{ branch: 'perf/core-tests', repo: 'GloBex/voice-bot' }])).toBe(true)
    expect(pushedHead(head, [{ branch: 'perf/core-tests', repo: 'globex/dashboard' }])).toBe(false)
    expect(pushedHead(head, [{ branch: 'chore/cut-release', repo: null }])).toBe(false)
  })
})

describe('transcriptEvidence', () => {
  it('counts URLs only from the results of calls that open PRs, including subagent calls', () => {
    const other = 'https://github.com/a/b/pull/2'
    const rows = [
      bash('t1', 'gh pr create --fill', 'toolu_sub'),
      result('t1', `${PR}\n`),
      bash('t2', 'gh pr list -R a/b'),
      result('t2', other),
      call('t3', 'mcp__github__create_pull_request', { owner: 'a', repo: 'b' }),
      result('t3', JSON.stringify({ html_url: 'https://github.com/a/b/pull/3' })),
      call('t4', 'Read', { file_path: 'chat.md' }),
      result('t4', '@optimize opened https://github.com/a/b/pull/4'),
    ]
    expect(transcriptEvidence(rows).created).toEqual(new Set([PR, 'https://github.com/a/b/pull/3']))
  })

  it('collects pushes with what their results printed', () => {
    const rows = [
      bash('p1', 'git push -q -u origin ci/gates'),
      result('p1', ''),
      bash('p2', 'git push'),
      result('p2', 'To github.com:a/b.git\n   1a2b3c4..5d6e7f8  fix/x -> fix/x'),
    ]
    expect(transcriptEvidence(rows).pushes).toEqual([
      { branch: 'ci/gates', repo: null },
      { branch: 'fix/x', repo: 'a/b' },
    ])
  })

  it('takes the PRs Claude Code reports the session created or pushed to, and no other change', () => {
    const report = (url: string, action: string): StoredRow => ({
      kind: 'sdk',
      payload: JSON.stringify({ type: 'system', subtype: 'code_change_published', provider: 'github', url, action }),
    })
    const evidence = transcriptEvidence([
      report(PR, 'created'),
      report('https://github.com/a/b/pull/5', 'pushed'),
      report('https://github.com/a/b/pull/6', 'commented'),
    ])
    expect(evidence.created).toEqual(new Set([PR]))
    expect(evidence.pushedTo).toEqual(new Set(['https://github.com/a/b/pull/5']))
  })

  it('ignores results without their call and rows that are not SDK messages', () => {
    const rows: StoredRow[] = [
      result('lost', PR),
      { kind: 'input', payload: JSON.stringify({ source: 'team', body: PR }) },
      { kind: 'sdk', payload: 'not json' },
    ]
    expect(transcriptEvidence(rows)).toEqual({ created: new Set(), pushedTo: new Set(), pushes: [] })
  })
})
