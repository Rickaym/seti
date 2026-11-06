import { describe, expect, it } from 'vitest'
import { alwaysRules, builtInRules, composeRules } from './permission-policy.js'

const compose = (sandboxed: boolean) =>
  composeRules({
    builtIn: builtInRules(),
    sandboxed,
    stored: [
      { behavior: 'allow', rule: 'Bash(pnpm test:*)' },
      { behavior: 'deny', rule: 'WebFetch' },
      { behavior: 'allow', rule: 'Read' },
    ],
    fixedDeny: ['Read(//home/me/.ssh)'],
  })

describe('permission rules', () => {
  it('lets a sandboxed agent run the shell and edit, which the sandbox contains', () => {
    const rules = compose(true)
    expect(rules.allow).toEqual(expect.arrayContaining(['Read', 'Bash', 'Edit', 'Bash(pnpm test:*)']))
    expect(rules.allow).not.toContain('Bash(gh pr view:*)')
    expect(rules.ask).toEqual([])
  })

  it('allows an unsandboxed agent only GitHub reads in the shell and asks before it edits hook files', () => {
    const rules = compose(false)
    expect(rules.allow).not.toContain('Bash')
    expect(rules.allow).not.toContain('Edit')
    expect(rules.allow).toEqual(expect.arrayContaining(['Read', 'Bash(gh pr view:*)', 'Bash(pnpm test:*)']))
    const shell = rules.allow.filter((rule) => rule.startsWith('Bash('))
    expect(shell.filter((rule) => !rule.startsWith('Bash(gh ') && rule !== 'Bash(pnpm test:*)')).toEqual([])
    expect(rules.ask).toContain('Edit(//**/.claude/settings.json)')
  })

  it('denies killing by name, credentials and what the user denied, for every agent, each once', () => {
    for (const rules of [compose(true), compose(false)]) {
      expect(rules.deny).toEqual(
        expect.arrayContaining(['Bash(pkill:*)', 'Bash(killall:*)', 'WebFetch', 'Read(//home/me/.ssh)']),
      )
      expect(rules.allow.filter((rule) => rule === 'Read')).toHaveLength(1)
    }
  })
})

describe('Always allow', () => {
  it("offers Claude Code's suggested rules", () => {
    const rules = alwaysRules(
      'Bash',
      { command: 'pnpm test && pnpm lint' },
      {
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'localSettings',
            rules: [
              { toolName: 'Bash', ruleContent: 'pnpm test:*' },
              { toolName: 'Bash', ruleContent: 'pnpm lint:*' },
            ],
          },
          { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
        ],
      },
    )
    expect(rules).toEqual(['Bash(pnpm test:*)', 'Bash(pnpm lint:*)'])
  })

  it('turns a directory suggestion into a rule for the tool that asked', () => {
    const update = { type: 'addDirectories' as const, directories: ['/srv/data'], destination: 'session' as const }
    expect(alwaysRules('Write', { file_path: '/srv/data/a' }, { suggestions: [update] })).toEqual([
      'Edit(//srv/data/**)',
    ])
    expect(alwaysRules('Read', { file_path: '/srv/data/a' }, { suggestions: [update] })).toEqual([
      'Read(//srv/data/**)',
    ])
  })

  it('falls back to a rule for just this call', () => {
    expect(alwaysRules('mcp__linear__create_issue', {}, {})).toEqual(['mcp__linear__create_issue'])
    expect(alwaysRules('Bash', { command: 'make deploy' }, {})).toEqual(['Bash(make deploy)'])
    expect(alwaysRules('WebFetch', { url: 'https://docs.example.com/a' }, {})).toEqual([
      'WebFetch(domain:docs.example.com)',
    ])
    expect(alwaysRules('Bash', { command: 'a\nb' }, {})).toEqual([])
  })

  it('offers none for a plan or when Claude Code says the rule would grant too much', () => {
    expect(alwaysRules('ExitPlanMode', { plan: 'x' }, {})).toEqual([])
    expect(alwaysRules('Bash', { command: 'ls' }, { suppressAlwaysAllowRule: true })).toEqual([])
  })
})
