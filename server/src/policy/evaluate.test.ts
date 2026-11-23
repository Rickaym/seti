import { describe, expect, it } from 'vitest'
import { bash, CWD, decideClaude, HOME, WORKSPACE } from './policy-fixtures.js'

const unsandboxed = { sandboxed: false } as const

describe('the order of decisions', () => {
  it('lets a deny rule beat a narrower allow rule', () => {
    const decision = bash('aws s3 ls', {
      ...unsandboxed,
      rules: [
        ['allow', 'Bash(aws s3 ls)'],
        ['deny', 'Bash(aws *)'],
      ],
    })
    expect(decision).toMatchObject({ verdict: 'deny', step: 'deny-rule', rule: 'rule:2' })
  })

  it('lets an ask rule beat a more specific allow rule', () => {
    const rules = [
      ['allow', 'Bash(git push origin main)'],
      ['ask', 'Bash(git push *)'],
    ] as const
    expect(bash('git push origin main', { ...unsandboxed, rules })).toMatchObject({ verdict: 'ask', rule: 'rule:2' })
  })

  it('runs Seti guard before any rule, whatever the mode', () => {
    const decision = bash('rm -rf /etc', { mode: 'bypass', guard: true })
    expect(decision).toMatchObject({ verdict: 'deny', step: 'guard', rule: null })
  })

  it('denies killing by name through the built-in rule, nested too', () => {
    expect(bash('pkill node')).toMatchObject({ verdict: 'deny', rule: 'builtin:deny:Bash(pkill:*)' })
    expect(bash("bash -c 'killall node'")).toMatchObject({ verdict: 'deny', rule: 'builtin:deny:Bash(killall:*)' })
    expect(bash('echo "$(pkill -f x)"')).toMatchObject({ verdict: 'deny' })
  })

  it('holds a reviewed tool-server call unless a deny rule names it', () => {
    const review = { rules: [['review', 'mcp__slack']] } as const
    expect(decideClaude('mcp__slack__send', { text: 'hi' }, review)).toMatchObject({
      verdict: 'review',
      rule: 'rule:1',
    })
    const denied = {
      rules: [
        ['review', 'mcp__slack'],
        ['deny', 'mcp__slack__send'],
      ],
    } as const
    expect(decideClaude('mcp__slack__send', {}, denied)).toMatchObject({ verdict: 'deny', rule: 'rule:2' })
    expect(decideClaude('mcp__other__send', {}, review).verdict).not.toBe('review')
  })

  it('asks the user every question and plan, even in bypass', () => {
    expect(decideClaude('AskUserQuestion', {}, { mode: 'bypass' })).toMatchObject({ verdict: 'ask', step: 'question' })
    expect(decideClaude('ExitPlanMode', { plan: 'x' }, { mode: 'bypass' })).toMatchObject({
      verdict: 'ask',
      step: 'plan',
    })
  })

  it('keeps ask rules in bypass, as Claude Code does', () => {
    expect(bash('git push', { mode: 'bypass', rules: [['ask', 'Bash(git push:*)']] })).toMatchObject({
      verdict: 'ask',
      step: 'ask-rule',
    })
  })
})

describe('credentials and protected files', () => {
  it('denies reading and editing credential folders, through file tools and the shell', () => {
    expect(decideClaude('Read', { file_path: `${HOME}/.ssh/id_rsa` })).toMatchObject({
      verdict: 'deny',
      rule: 'fixed:0',
    })
    expect(decideClaude('Edit', { file_path: `${HOME}/.aws/config` })).toMatchObject({ verdict: 'deny' })
    expect(decideClaude('Write', { file_path: `${HOME}/.ssh/x` })).toMatchObject({ verdict: 'deny', rule: 'fixed:0' })
    expect(decideClaude('Grep', { pattern: 'k', path: `${HOME}/.ssh` })).toMatchObject({ verdict: 'deny' })
    expect(bash('cat ~/.ssh/id_rsa')).toMatchObject({ verdict: 'deny', step: 'deny-rule' })
    expect(bash('echo key >> ~/.ssh/authorized_keys')).toMatchObject({ verdict: 'deny', step: 'deny-rule' })
    expect(bash('cp x y && head -1 /home/me/.aws/credentials')).toMatchObject({ verdict: 'deny' })
  })

  it('never lets a rule approve a protected write, and leaves it to the mode', () => {
    const write = (mode: 'auto' | 'bypass' | 'ask') =>
      decideClaude('Edit', { file_path: `${CWD}/.git/hooks/pre-commit` }, { mode })
    expect(write('auto')).toMatchObject({ verdict: 'defer', step: 'safety' })
    expect(write('bypass')).toMatchObject({ verdict: 'allow', step: 'safety' })
    expect(write('ask')).toMatchObject({ verdict: 'ask', step: 'safety' })
  })

  it('asks before removing home, the root or the working directory, even in bypass', () => {
    expect(bash('rm -rf ~', { mode: 'bypass' })).toMatchObject({ verdict: 'ask', step: 'safety' })
    expect(bash(`cd /tmp && rm -rf ${CWD}`, { mode: 'bypass' })).toMatchObject({ verdict: 'ask', step: 'safety' })
    expect(bash('rm -rf build', { mode: 'bypass', sandboxed: false })).toMatchObject({ verdict: 'allow', step: 'mode' })
  })

  it('asks for a write to the user settings of an unsandboxed agent, and denies it to a sandboxed one', () => {
    const file = `${CWD}/.claude/settings.json`
    expect(decideClaude('Edit', { file_path: file }, unsandboxed)).toMatchObject({ verdict: 'ask', step: 'ask-rule' })
    expect(
      decideClaude('Write', { file_path: file }, { rules: [['deny', 'Edit(//**/.claude/settings.json)']] }),
    ).toMatchObject({ verdict: 'deny' })
  })

  it('anchors a /path rule from user settings at ~/.claude', () => {
    const inherited = [['deny', 'Read(/secrets/**)']] as const
    expect(decideClaude('Read', { file_path: `${HOME}/.claude/secrets/k` }, { inherited })).toMatchObject({
      verdict: 'deny',
      rule: 'inherited:user:0',
    })
    expect(decideClaude('Read', { file_path: `${CWD}/secrets/k` }, { inherited }).verdict).toBe('allow')
  })
})

describe('allow rules', () => {
  it('allows GitHub reads outside the sandbox only when every command is allowed', () => {
    expect(bash('gh pr view 3', unsandboxed)).toMatchObject({
      verdict: 'allow',
      rule: 'builtin:allow:Bash(gh pr view:*)',
    })
    expect(bash('gh pr view 3 && gh pr checks 3', unsandboxed).verdict).toBe('allow')
    expect(bash('gh pr view 3 && rm x', unsandboxed).verdict).toBe('defer')
    expect(bash('gh pr view 3 $(rm x)', unsandboxed).verdict).toBe('defer')
    expect(bash('gh pr view 3 &&', unsandboxed).verdict).toBe('defer')
  })

  it('counts a cd inside the working directories as read-only, but not a cd before git', () => {
    const rules = [
      ['allow', 'Bash(npm test)'],
      ['allow', 'Bash(git status)'],
    ] as const
    expect(bash('cd packages/api && npm test', { ...unsandboxed, rules }).verdict).toBe('allow')
    expect(bash('cd /etc && npm test', { ...unsandboxed, rules }).verdict).toBe('defer')
    expect(bash('cd packages/api && git status', { ...unsandboxed, rules }).verdict).toBe('defer')
  })

  it('checks where a command writes and reads, not only the command', () => {
    const setup = { ...unsandboxed, mode: 'ask', rules: [['allow', 'Bash(git log:*)']] } as const
    expect(bash('git log > log.txt', setup).verdict).toBe('allow')
    expect(bash('git log > /tmp/log.txt', setup).verdict).toBe('ask')
    expect(bash('git log > ~/log.txt', setup).verdict).toBe('ask')
    expect(bash(`git log > ${WORKSPACE}/log.txt`, setup).verdict).toBe('allow')
    expect(bash('git log > .git/config', setup).verdict).toBe('ask')
    expect(bash('git log | tee /tmp/x', { ...setup, rules: [...setup.rules, ['allow', 'Bash(tee:*)']] }).verdict).toBe(
      'ask',
    )
    expect(bash('git log < /etc/hosts', setup).verdict).toBe('allow')
    expect(bash('git log < $FILE', setup).verdict).toBe('ask')
    expect(bash('git log 2>/dev/null', setup).verdict).toBe('allow')
  })

  it('approves exec wrappers, find actions and interactive commands only with an exact rule', () => {
    const setup = {
      ...unsandboxed,
      mode: 'ask',
      rules: [
        ['allow', 'Bash(find *)'],
        ['allow', 'Bash(watch *)'],
      ],
    } as const
    expect(bash('find . -name x', setup).verdict).toBe('allow')
    expect(bash('find . -delete', setup).verdict).toBe('ask')
    expect(bash('watch make', setup).verdict).toBe('ask')
    expect(bash('find . -delete', { ...setup, rules: [['allow', 'Bash(find . -delete)']] }).verdict).toBe('allow')
    const python = { ...unsandboxed, mode: 'ask', rules: [['allow', 'Bash(python *)']] } as const
    expect(bash('python app.py', python).verdict).toBe('allow')
  })

  it('matches web fetches by domain and tool-server tools by server', () => {
    const rules = [
      ['allow', 'WebFetch(domain:*.example.com)'],
      ['allow', 'mcp__github__get_*'],
    ] as const
    const setup = { ...unsandboxed, rules }
    expect(decideClaude('WebFetch', { url: 'https://docs.example.com/x' }, setup).verdict).toBe('allow')
    expect(decideClaude('WebFetch', { url: 'https://example.com/x' }, setup).verdict).toBe('defer')
    expect(decideClaude('mcp__github__get_issue', {}, setup).verdict).toBe('allow')
    expect(decideClaude('mcp__github__create_issue', {}, setup).verdict).toBe('defer')
    expect(decideClaude('mcp__seti__list_agents', {}, setup).rule).toBe('builtin:allow:mcp__seti')
  })

  it('reads parameter rules for deny and ask only', () => {
    const rules = [
      ['ask', 'Bash(run_in_background:true)'],
      ['allow', 'Agent(model:opus)'],
    ] as const
    expect(bash('npm run dev', { rules }).verdict).not.toBe('ask')
    expect(decideClaude('Bash', { command: 'npm run dev', run_in_background: true }, { rules })).toMatchObject({
      verdict: 'ask',
      rule: 'rule:1',
    })
    expect(decideClaude('Agent', { model: 'opus', prompt: 'x' }, { mode: 'ask', rules }).verdict).toBe('ask')
  })
})
