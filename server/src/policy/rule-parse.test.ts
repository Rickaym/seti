import { describe, expect, it } from 'vitest'
import { droppedInAuto, parseRule } from './rule-parse.js'

describe('reading a rule', () => {
  it.each([
    ['Bash', { type: 'tool', name: 'Bash' }],
    ['Bash(*)', { type: 'tool', name: 'Bash' }],
    ['Task', { type: 'tool', name: 'Agent' }],
    ['Bash(npm run *)', { type: 'command', pattern: 'npm run *' }],
    ['Bash(gh pr view:*)', { type: 'command', pattern: 'gh pr view:*' }],
    ['Bash(run_in_background:true)', { type: 'param', tool: 'Bash', key: 'run_in_background', value: 'true' }],
    ['Bash(command:rm *)', { type: 'never' }],
    ['Read(./.env)', { type: 'path', tool: 'Read', pattern: './.env' }],
    ['Edit(//home/me/**)', { type: 'path', tool: 'Edit', pattern: '//home/me/**' }],
    ['Edit(./Finance (2024)/**)', { type: 'path', tool: 'Edit', pattern: './Finance (2024)/**' }],
    ['Read(limit : 10)', { type: 'param', tool: 'Read', key: 'limit', value: '10' }],
    ['Write(docs/**)', { type: 'never' }],
    ['Grep(docs/**)', { type: 'never' }],
    ['Write(*)', { type: 'tool', name: 'Write' }],
    ['WebFetch(domain:example.com)', { type: 'domain', pattern: 'example.com' }],
    ['WebFetch(url:https://x)', { type: 'never' }],
    ['WebFetch(something)', { type: 'never' }],
    ['mcp__slack', { type: 'mcp', server: 'slack', tool: null }],
    ['mcp__slack__*', { type: 'mcp', server: 'slack', tool: '*' }],
    ['mcp__github__get_*', { type: 'mcp', server: 'github', tool: 'get_*' }],
    ['mcp__slack__send_message', { type: 'mcp', server: 'slack', tool: 'send_message' }],
    ['mcp__slack__send(channel:x)', { type: 'never' }],
    ['mcp__*', { type: 'tool-glob', glob: 'mcp__*' }],
    ['*', { type: 'tool-glob', glob: '*' }],
    ['Agent(Explore)', { type: 'agent', pattern: 'Explore' }],
    ['Agent(model:opus)', { type: 'param', tool: 'Agent', key: 'model', value: 'opus' }],
    ['Skill(skill:deploy)', { type: 'param', tool: 'Skill', key: 'skill', value: 'deploy' }],
    ['Skill(deploy)', { type: 'opaque', name: 'Skill' }],
    ['Bash()', { type: 'never' }],
    ['Bash(npm test', { type: 'never' }],
    ['npm test)', { type: 'never' }],
    ['', { type: 'never' }],
  ])('%s', (text, target) => {
    expect(parseRule(text)).toEqual(target)
  })
})

describe('allow rules auto mode drops', () => {
  it.each([
    'Bash',
    'Bash(*)',
    'Bash(python*)',
    'Bash(python3 -m pytest *)',
    'Bash(node:*)',
    'Bash(timeout *)',
    'Bash(nohup:*)',
    'Bash(* --version)',
    'Bash($HOME/bin/*)',
    'Bash(./scripts/*)',
    'Bash(npm run *)',
    'Bash(pnpm *)',
    'Bash(npx *)',
    'Bash(uv run *)',
    'Bash(make *)',
    'Agent',
    'Agent(Explore)',
    'Monitor',
  ])('drops %s', (text) => {
    expect(droppedInAuto(parseRule(text))).toBe(true)
  })

  it.each(['Bash(npm test)', 'Bash(git status:*)', 'Bash(gh pr view:*)', 'Edit', 'Read', 'mcp__seti', 'WebFetch'])(
    'keeps %s',
    (text) => {
      expect(droppedInAuto(parseRule(text))).toBe(false)
    },
  )
})
