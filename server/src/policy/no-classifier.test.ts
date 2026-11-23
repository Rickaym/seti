import { describe, expect, it } from 'vitest'
import { decide } from './evaluate.js'
import { bash, claudeCall, contextOf, CWD, decideClaude } from './policy-fixtures.js'

const sandboxed = { sandboxed: true, classifier: false } as const
const unsandboxed = { sandboxed: false, classifier: false } as const

describe('a runtime without a classifier', () => {
  it('asks where a runtime with one would defer', () => {
    expect(bash('make', { ...unsandboxed, mode: 'auto' })).toMatchObject({ verdict: 'ask', step: 'mode' })
    expect(bash('make', { ...unsandboxed, mode: 'plan' })).toMatchObject({ verdict: 'ask', step: 'mode' })
    expect(decideClaude('mcp__x__y', {}, unsandboxed)).toMatchObject({ verdict: 'ask', step: 'mode' })
    expect(decideClaude('Edit', { file_path: `${CWD}/.git/config` }, unsandboxed)).toMatchObject({
      verdict: 'ask',
      step: 'safety',
    })
    expect(bash('make', { sandboxed: false, mode: 'auto' }).verdict).toBe('defer')
  })

  it("honours the sandbox's built-in shell allow in auto only for a line Seti fully reads", () => {
    expect(bash('npm test', sandboxed)).toMatchObject({
      verdict: 'allow',
      step: 'allow-rule',
      rule: 'builtin:allow:Bash',
    })
    expect(bash('npm test && git push', sandboxed).verdict).toBe('allow')
    expect(bash('npm test $(cat x)', sandboxed)).toMatchObject({ verdict: 'ask', step: 'mode' })
    expect(bash('npm test &&', sandboxed).verdict).toBe('ask')
    expect(bash('npm test <<EOF\nx\nEOF', sandboxed).verdict).toBe('ask')
    expect(bash('npm test', { sandboxed: true }).verdict).toBe('defer')
  })

  it('keeps a user rule for every command dropped in auto', () => {
    expect(bash('npm test', { ...unsandboxed, rules: [['allow', 'Bash']] }).verdict).toBe('ask')
    expect(bash('npm test', { ...unsandboxed, rules: [['allow', 'Bash(npm test)']] }).verdict).toBe('allow')
  })

  it('never approves an interactive shell with the built-in allow or the read-only list', () => {
    const call = { ...claudeCall('Bash', { command: 'git log' }), interactive: true }
    expect(decide(call, contextOf(sandboxed)).verdict).toBe('ask')
    expect(decide(call, contextOf({ ...unsandboxed, mode: 'ask' })).verdict).toBe('ask')
  })

  it("does not honour the sandbox's shell allow in plan mode, as Claude Code without auto mode does", () => {
    expect(bash('npm test', { ...sandboxed, mode: 'plan' })).toMatchObject({ verdict: 'ask', step: 'mode' })
    expect(bash('ls src', { ...sandboxed, mode: 'plan' })).toMatchObject({ verdict: 'allow', step: 'read-only' })
  })

  it('lets read-only lines run in every mode, after deny and ask rules', () => {
    for (const mode of ['ask', 'auto', 'plan'] as const) {
      expect(bash('git status', { ...unsandboxed, mode })).toMatchObject({ verdict: 'allow', step: 'read-only' })
    }
    expect(bash('cat .env', { ...unsandboxed, rules: [['deny', 'Read(./.env)']] }).verdict).toBe('deny')
    expect(bash('git log', { ...unsandboxed, rules: [['ask', 'Bash(git log:*)']] }).verdict).toBe('ask')
    expect(bash('cat /etc/hosts', { ...unsandboxed, mode: 'ask' }).verdict).toBe('ask')
  })

  it('leaves read-only commands to the runtime that has a classifier', () => {
    expect(bash('git status', { sandboxed: false, mode: 'ask' })).toMatchObject({ verdict: 'ask', step: 'mode' })
    expect(bash('git status', { sandboxed: false }).verdict).toBe('defer')
  })
})
