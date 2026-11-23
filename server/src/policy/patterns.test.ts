import { describe, expect, it } from 'vitest'
import { commandMatches, domainMatches, nameMatches, valueMatches, wildcard } from './patterns.js'

/** Claude Code's documented wildcard table: rule, commands it matches, commands it does not. */
const COMMAND_TABLE: [string, string[], string[]][] = [
  ['npm run build', ['npm run build'], ['npm run build --watch']],
  ['npm run *', ['npm run build', 'npm run test --watch', 'npm run'], ['npm install']],
  [
    'git log * main',
    ['git log --oneline main', 'git log -5 main', 'git log --output=x main'],
    ['git log main', 'git push origin main'],
  ],
  ['git * main', ['git merge main', 'git push origin main', 'git -c core.fsmonitor=x diff main'], ['git log']],
  ['* --version', ['node --version', "bash -c 'echo hi' --version"], ['node -v']],
  ['ls *', ['ls -la', 'ls'], ['lsof']],
  ['ls*', ['ls -la', 'lsof'], []],
  ['* --help *', ['npm --help x'], ['npm --help']],
  ['ls:*', ['ls', 'ls -la'], ['lsof']],
  ['git:* push', [], ['git push', 'git status push']],
]

describe('shell rule patterns', () => {
  it.each(COMMAND_TABLE)('%s matches as Claude Code documents', (rule, matches, misses) => {
    for (const command of matches) {
      expect(commandMatches(rule, command), `${rule} on ${command}`).toBe(true)
    }
    for (const command of misses) {
      expect(commandMatches(rule, command), `${rule} on ${command}`).toBe(false)
    }
  })

  it('ignores runs of spaces and the ends of the line', () => {
    expect(commandMatches('npm  test', ' npm test ')).toBe(true)
  })
})

describe('web fetch domains', () => {
  it.each([
    ['example.com', 'https://example.com/a', true],
    ['example.com', 'https://api.example.com/a', false],
    ['*.example.com', 'https://api.example.com', true],
    ['*.example.com', 'https://a.b.example.com', true],
    ['*.example.com', 'https://example.com', false],
    ['*', 'https://anything.org', true],
    ['example.*', 'https://example.org', true],
    ['example.*', 'https://example.evil.com', false],
    ['Example.COM.', 'https://example.com./x', true],
    ['example.com', 'not a url', false],
  ])('%s on %s is %s', (rule, url, matches) => {
    expect(domainMatches(rule, url)).toBe(matches)
  })
})

describe('names and values', () => {
  it('matches tool-name globs against the whole name', () => {
    expect(nameMatches('mcp__*', 'mcp__slack__send')).toBe(true)
    expect(nameMatches('*', 'Bash')).toBe(true)
    expect(nameMatches('get_*', 'get_issue')).toBe(true)
    expect(nameMatches('get_*', 'list_get_issue')).toBe(false)
    expect(nameMatches('B?sh', 'Bash')).toBe(true)
  })

  it('compares a parameter value exactly unless it has a wildcard', () => {
    expect(valueMatches('opus', 'opus')).toBe(true)
    expect(valueMatches('opus', 'claude-opus-4')).toBe(false)
    expect(valueMatches('*', 'worktree')).toBe(true)
    expect(valueMatches('true', true)).toBe(true)
    expect(valueMatches('*', undefined)).toBe(false)
    expect(valueMatches('*', { nested: 1 })).toBe(false)
  })
})

describe('wildcards', () => {
  it.each([
    ['a*c', 'abc', true],
    ['a*c', 'ab', false],
    ['*', '', true],
    ['', '', true],
    ['a**b', 'ab', true],
    ['*a*b*', 'xxaxxbxx', true],
    ['*a*b', 'xxbxxa', false],
    ['a.b', 'axb', false],
    ['x*', 'x\ny', true],
  ])('%s on %s is %s', (glob, text, matches) => {
    expect(wildcard(glob, text)).toBe(matches)
  })

  it('reads ? as one character only when asked', () => {
    expect(wildcard('B?sh', 'Bash', true)).toBe(true)
    expect(wildcard('B?sh', 'Bash')).toBe(false)
    expect(wildcard('B?sh', 'B?sh')).toBe(true)
  })

  it('stays linear on a long call that a many-star rule does not match', () => {
    const text = `${'a '.repeat(200_000)}b`
    const started = performance.now()
    expect(commandMatches('a * a * a * a * c', text)).toBe(false)
    expect(valueMatches('*a*a*a*a*c', text)).toBe(false)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
