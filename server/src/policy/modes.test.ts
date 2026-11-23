import { describe, expect, it } from 'vitest'
import { policyMode } from './claude-call.js'
import { decide } from './evaluate.js'
import { bash, claudeCall, contextOf, CWD, decideClaude, HOME } from './policy-fixtures.js'

const unsandboxed = { sandboxed: false } as const

describe('what each mode does with a call no rule decides', () => {
  it('allows everything in bypass but what no mode allows', () => {
    expect(bash('curl https://x', { ...unsandboxed, mode: 'bypass' })).toMatchObject({ verdict: 'allow', step: 'mode' })
    expect(decideClaude('mcp__x__y', {}, { mode: 'bypass' }).verdict).toBe('allow')
  })

  it('hands the rest to the classifier in auto, after reads and edits inside the working directories', () => {
    const auto = { ...unsandboxed, mode: 'auto' } as const
    expect(decideClaude('Read', { file_path: '/etc/hosts' }, auto).verdict).toBe('allow')
    expect(decideClaude('Edit', { file_path: `${CWD}/a.ts` }, auto).verdict).toBe('allow')
    expect(decideClaude('NotebookEdit', { notebook_path: '/srv/n.ipynb' }, auto).verdict).toBe('defer')
    expect(bash('make', auto).verdict).toBe('defer')
    expect(decideClaude('mcp__x__y', {}, auto).verdict).toBe('defer')
  })

  it('asks for what no rule allows by default, reads inside the working directories aside', () => {
    const ask = { ...unsandboxed, mode: 'ask' } as const
    expect(decideClaude('Glob', { pattern: '*.ts' }, ask).verdict).toBe('allow')
    expect(decideClaude('NotebookRead', { notebook_path: '/etc/n.ipynb' }, ask).verdict).toBe('ask')
    expect(decideClaude('Edit', { file_path: `${CWD}/a.ts` }, ask).verdict).toBe('ask')
    expect(bash('make', ask).verdict).toBe('ask')
  })

  it('asks before an edit in plan mode and lets the classifier review commands', () => {
    const plan = { ...unsandboxed, mode: 'plan' } as const
    expect(decideClaude('Edit', { file_path: `${CWD}/a.ts` }, plan).verdict).toBe('ask')
    expect(bash('make', plan).verdict).toBe('defer')
    expect(decideClaude('NotebookRead', { notebook_path: `${CWD}/n.ipynb` }, plan).verdict).toBe('allow')
  })

  it('lets no allow rule approve an edit in plan mode, and drops the broad ones as auto does', () => {
    const plan = { sandboxed: true, mode: 'plan' } as const
    expect(decideClaude('Edit', { file_path: `${CWD}/a.ts` }, plan)).toMatchObject({ verdict: 'ask', step: 'plan' })
    expect(decideClaude('Write', { file_path: `${CWD}/b.ts` }, plan)).toMatchObject({ verdict: 'ask', step: 'plan' })
    expect(bash('make', plan)).toMatchObject({ verdict: 'defer', step: 'mode' })
    expect(bash('make', { ...plan, rules: [['allow', 'Bash(make)']] })).toMatchObject({ verdict: 'allow' })
  })

  it('never asks about tools that track the agent own work', () => {
    for (const tool of ['TodoWrite', 'TaskUpdate', 'EnterPlanMode', 'BashOutput']) {
      expect(decideClaude(tool, {}, { ...unsandboxed, mode: 'ask' }).verdict).toBe('allow')
    }
  })

  it('drops subagent allow rules in auto and keeps them by default', () => {
    const rules = [['allow', 'Agent(Explore)']] as const
    const call = { subagent_type: 'Explore', prompt: 'look' }
    expect(decideClaude('Agent', call, { rules, mode: 'auto' }).verdict).toBe('defer')
    expect(decideClaude('Task', call, { rules, mode: 'ask' })).toMatchObject({ verdict: 'allow', rule: 'rule:1' })
  })

  it('approves an interactive command only with an exact rule', () => {
    const ctx = contextOf({ ...unsandboxed, mode: 'ask', rules: [['allow', 'Bash(python *)']] })
    const call = { ...claudeCall('Bash', { command: 'python repl.py' }), interactive: true }
    expect(decide(call, ctx).verdict).toBe('ask')
    expect(decide({ ...call, interactive: false }, ctx).verdict).toBe('allow')
  })
})

describe('reading Claude Code calls', () => {
  it('takes the parts rules match from each tool', () => {
    expect(claudeCall('Bash', { command: 'ls', run_in_background: false })).toMatchObject({
      kind: 'shell',
      command: 'ls',
      params: { command: 'ls', run_in_background: false },
    })
    expect(claudeCall('Grep', { pattern: 'x' })).toMatchObject({ kind: 'search', reads: ['.'] })
    expect(claudeCall('NotebookEdit', { notebook_path: 'n.ipynb' })).toMatchObject({
      kind: 'edit',
      writes: ['n.ipynb'],
    })
    expect(claudeCall('WebFetch', { url: 'https://x' })).toMatchObject({ kind: 'web', url: 'https://x' })
    expect(claudeCall('mcp__slack__send_message', {})).toMatchObject({
      kind: 'mcp',
      mcp: { server: 'slack', tool: 'send_message' },
    })
    expect(claudeCall('Task', {})).toMatchObject({ kind: 'subagent', agentType: 'general-purpose' })
    expect(claudeCall('Skill', { skill: 'x', nested: { a: 1 } }).params).toEqual({ skill: 'x' })
    expect(claudeCall('MultiEdit', { file_path: 'a.ts', edits: [{}, {}] }).writes).toEqual(['a.ts'])
    expect(claudeCall('Edit', { file_path: '' }).writes).toEqual([])
    expect(claudeCall('ToolSearch', { query: 'slack' })).toMatchObject({ kind: 'search', reads: [] })
    expect(claudeCall('Monitor', { command: 'tail -f x' }).command).toBeUndefined()
  })

  it('reads Claude Code modes as Seti modes, any other as ask', () => {
    expect(policyMode('auto')).toBe('auto')
    expect(policyMode('bypassPermissions')).toBe('bypass')
    expect(policyMode('plan')).toBe('plan')
    expect(policyMode('default')).toBe('ask')
    expect(policyMode('acceptEdits')).toBe('ask')
    expect(policyMode(undefined)).toBe('ask')
  })

  it('names each rule without the user text it holds', () => {
    const refs = contextOf({ rules: [['allow', 'Bash(secret-ish)']], inherited: [['deny', 'Read(~/x)']] }).rules.map(
      (rule) => rule.ref,
    )
    expect(refs).toEqual(expect.arrayContaining(['rule:1', 'workspace', 'fixed:0', 'inherited:user:0']))
    expect(refs.join(' ')).not.toContain('secret-ish')
    expect(refs.join(' ')).not.toContain(HOME)
    expect(refs.join(' ')).not.toContain('settings.json')
  })
})
