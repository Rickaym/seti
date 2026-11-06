import {
  checkComposer,
  closestCommand,
  confirmationFor,
  nextWordEnd,
  parseComposer,
  previousWordStart,
  rankCommands,
  requiresArguments,
  shellIssues,
  withSetiCommands,
  type ComposerCommand,
} from '@seti/shared'
import { describe, expect, it } from 'vitest'

const command = (name: string, extra: Partial<ComposerCommand> = {}): ComposerCommand => ({
  name,
  description: `${name} description`,
  argument_hint: '',
  aliases: [],
  builtin: true,
  unsupported: null,
  ...extra,
})

const COMMANDS = [
  command('compact', { argument_hint: '<optional custom summarization instructions>' }),
  command('context', { description: 'Show current context usage' }),
  command('code-review', { aliases: ['review'], argument_hint: '[low|high] [<pr#>]' }),
  command('batch', { argument_hint: '<instruction>' }),
  command('color', { unsupported: 'it only changes the terminal display' }),
  command('slack:summarize-channel', { builtin: false, description: 'Summarize recent activity in a channel' }),
  command('slack:standup', { builtin: false }),
  command('simplify'),
]

const names = (list: readonly ComposerCommand[]) => list.map((c) => c.name)

describe('parseComposer', () => {
  it('tells messages, slash commands and shell commands apart', () => {
    expect(parseComposer('fix the bug')).toEqual({ mode: 'text' })
    expect(parseComposer('  /compact keep the plan  ')).toEqual({
      mode: 'slash',
      name: 'compact',
      args: 'keep the plan',
    })
    expect(parseComposer('/slack:summarize-channel #eng')).toEqual({
      mode: 'slash',
      name: 'slack:summarize-channel',
      args: '#eng',
    })
    expect(parseComposer('/')).toEqual({ mode: 'slash', name: '', args: '' })
    expect(parseComposer('!  ls -la ')).toEqual({ mode: 'shell', command: 'ls -la' })
  })

  it('treats a leading path as a plain message', () => {
    expect(parseComposer('/home/user/app is broken')).toEqual({ mode: 'text' })
  })
})

describe('rankCommands', () => {
  it('puts exact and prefix matches before matches after a plugin prefix and substrings', () => {
    expect(names(rankCommands(COMMANDS, 'co'))).toEqual(['compact', 'context', 'code-review', 'color'])
    expect(names(rankCommands(COMMANDS, 'context'))[0]).toBe('context')
    expect(names(rankCommands(COMMANDS, 'sum'))).toEqual(['slack:summarize-channel'])
    expect(names(rankCommands(COMMANDS, 'review'))).toEqual(['code-review'])
    expect(names(rankCommands(COMMANDS, 'stand'))).toEqual(['slack:standup'])
    expect(names(rankCommands(COMMANDS, 'usage'))).toEqual(['context'])
    expect(rankCommands(COMMANDS, 'zzz')).toEqual([])
  })

  it('lists everything for an empty query, shortest names first, up to the limit', () => {
    expect(names(rankCommands(COMMANDS, '', 3))).toEqual(['batch', 'compact', 'context'])
  })

  it('sorts unsupported commands after supported ones with the same score', () => {
    expect(names(rankCommands([command('colour'), COMMANDS[4] ?? command('x')], 'col'))).toEqual(['colour', 'color'])
  })
})

describe('closestCommand', () => {
  it('suggests a supported command for a typo or a prefix', () => {
    expect(closestCommand(COMMANDS, 'compcat')).toBe('compact')
    expect(closestCommand(COMMANDS, 'summarize')).toBe('slack:summarize-channel')
    expect(closestCommand(COMMANDS, 'revew')).toBe('code-review')
    expect(closestCommand(COMMANDS, 'colr')).toBeNull()
    expect(closestCommand(COMMANDS, 'deploy-everything')).toBeNull()
  })
})

describe('requiresArguments', () => {
  it('reads angle brackets as required unless the hint says optional', () => {
    expect(requiresArguments('<instruction>')).toBe(true)
    expect(requiresArguments('<optional custom summarization instructions>')).toBe(false)
    expect(requiresArguments('[issue description]')).toBe(false)
    expect(requiresArguments('')).toBe(false)
  })
})

describe('checkComposer', () => {
  it('classifies commands against the list of the task directory', () => {
    expect(checkComposer('/compact', COMMANDS)).toMatchObject({ kind: 'command', command: { name: 'compact' } })
    expect(checkComposer('/review high', COMMANDS)).toMatchObject({ kind: 'command', command: { name: 'code-review' } })
    expect(checkComposer('/batch', COMMANDS)).toMatchObject({ kind: 'needs-args', command: { name: 'batch' } })
    expect(checkComposer('/batch rename foo', COMMANDS)).toMatchObject({ kind: 'command' })
    expect(checkComposer('/color red', COMMANDS)).toMatchObject({ kind: 'unsupported', command: { name: 'color' } })
    expect(checkComposer('/compcat', COMMANDS)).toEqual({ kind: 'unknown', name: 'compcat', suggestion: 'compact' })
    expect(checkComposer('/comp', COMMANDS)).toEqual({ kind: 'partial', name: 'comp', matches: 1 })
    expect(checkComposer('/sla', COMMANDS)).toEqual({ kind: 'partial', name: 'sla', matches: 2 })
    expect(checkComposer('/comp now', COMMANDS)).toMatchObject({ kind: 'unknown', suggestion: 'compact' })
    expect(checkComposer('/', COMMANDS)).toEqual({ kind: 'no-name' })
    expect(checkComposer('/compact', null)).toEqual({ kind: 'unchecked', name: 'compact' })
    expect(checkComposer('hello', COMMANDS)).toEqual({ kind: 'text' })
    expect(checkComposer('!echo "hi', COMMANDS)).toEqual({
      kind: 'shell',
      command: 'echo "hi',
      issues: ['Unclosed double quote'],
    })
  })
})

describe("a mod's slash command", () => {
  const seti = command('btw', { description: 'Ask a side question', builtin: true })

  it('wins over a Claude Code or plugin command of the same name or alias', () => {
    const listed = withSetiCommands(
      [
        command('compact'),
        command('btw', { description: 'Claude Code btw' }),
        command('BTW', { builtin: false }),
        command('aside', { builtin: false, aliases: ['btw', 'side'] }),
      ],
      [seti],
    )
    expect(names(listed)).toEqual(['aside', 'btw', 'compact'])
    expect(listed.find((c) => c.name === 'btw')).toBe(seti)
    expect(listed.find((c) => c.name === 'aside')?.aliases).toEqual(['side'])
    expect(checkComposer('/btw', listed)).toMatchObject({ kind: 'command', command: seti })
    expect(names(rankCommands(listed, 'bt'))).toEqual(['btw'])
  })
})

describe('confirmationFor', () => {
  it('asks before sending an unknown or unsupported command or a malformed shell command', () => {
    expect(confirmationFor(checkComposer('/nope', COMMANDS))).toBe(
      '/nope is not available to this agent. Send it anyway?',
    )
    expect(confirmationFor(checkComposer('/color', COMMANDS))).toContain('not supported in Seti')
    expect(confirmationFor(checkComposer('/comp', COMMANDS))).toBe(
      '/comp is not available to this agent. Send it anyway?',
    )
    expect(confirmationFor(checkComposer("!echo 'x", COMMANDS))).toBe('Unclosed single quote. Run it anyway?')
  })

  it('sends known commands, messages and unchecked commands without asking', () => {
    for (const text of ['/compact', '/batch', 'hello', '!ls', '/'] as const) {
      expect(confirmationFor(checkComposer(text, COMMANDS))).toBeNull()
    }
    expect(confirmationFor(checkComposer('/nope', null))).toBeNull()
  })
})

describe('shellIssues', () => {
  it.each([
    ['ls -la', []],
    ['echo "it\'s fine"', []],
    [String.raw`echo it\'s`, []],
    ["echo hi # don't worry", []],
    ['printf "%s\\n" `date`', []],
    ['sleep 1 &', []],
    ['ls | wc -l', []],
    ['', ['Empty command']],
    ['   ', ['Empty command']],
    ['echo "open', ['Unclosed double quote']],
    ["echo 'open", ['Unclosed single quote']],
    ['echo `date', ['Unclosed backtick']],
    ['echo a \\', ['Ends with a line continuation']],
    ['ls |', ['Ends with an operator that needs another command']],
    ['make &&', ['Ends with an operator that needs another command']],
  ])('%j gives %j', (text, issues) => {
    expect(shellIssues(text)).toEqual(issues)
  })
})

describe('word boundaries', () => {
  it('finds where Ctrl+Backspace stops', () => {
    expect(previousWordStart('hello brave world', 17)).toBe(12)
    expect(previousWordStart('hello brave world  ', 19)).toBe(12)
    expect(previousWordStart('hello brave world', 11)).toBe(6)
    expect(previousWordStart('path/to/file', 12)).toBe(8)
    expect(previousWordStart('path/to/', 8)).toBe(7)
    expect(previousWordStart('word', 0)).toBe(0)
    expect(previousWordStart('  ', 2)).toBe(0)
  })

  it('finds where Ctrl+Delete stops', () => {
    expect(nextWordEnd('hello brave world', 0)).toBe(5)
    expect(nextWordEnd('hello brave world', 5)).toBe(11)
    expect(nextWordEnd('a.b', 1)).toBe(2)
    expect(nextWordEnd('end', 3)).toBe(3)
  })
})
