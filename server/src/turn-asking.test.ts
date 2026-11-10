import { describe, expect, it } from 'vitest'
import { endsAsking, endsWithQuestion, turnBlocks, type TurnBlock } from './turn-asking.js'

const text = (value: string): TurnBlock => ({ type: 'text', text: value })
const tool = (name: string): TurnBlock => ({ type: 'tool_use', name })

describe('endsWithQuestion', () => {
  it('reads the last paragraph, whatever whitespace trails it', () => {
    expect(endsWithQuestion('Which branch should I use?')).toBe(true)
    expect(endsWithQuestion('I fixed the test.\n\nShould I merge it?  \n\n \t\n')).toBe(true)
    expect(endsWithQuestion('Done.')).toBe(false)
    expect(endsWithQuestion('')).toBe(false)
  })

  it('ignores a rhetorical question before the end', () => {
    expect(endsWithQuestion('Why did CI fail? The cache was stale.')).toBe(false)
    expect(endsWithQuestion('Should I keep the flag?\n\nI kept it, since two callers read it.')).toBe(false)
  })

  it('ignores questions inside code blocks, closed or not', () => {
    expect(endsWithQuestion('The new rule:\n\n```ts\nconst name = user?.name ?? "who?"\n```')).toBe(false)
    expect(endsWithQuestion('The pattern:\n\n~~~\n/colou?r?/\n~~~\n')).toBe(false)
    expect(endsWithQuestion('Run this:\n\n```sh\necho "ready?"')).toBe(false)
    expect(endsWithQuestion('Shall I apply this diff?\n\n```diff\n- a\n+ b\n```')).toBe(true)
  })

  it('looks past emphasis and closing marks after the question mark', () => {
    expect(endsWithQuestion('**Want me to open a PR?**')).toBe(true)
    expect(endsWithQuestion('(Or should I wait for review?)')).toBe(true)
    expect(endsWithQuestion('Two choices left:\n1. Keep the table?\n2. Drop the column?')).toBe(true)
  })
})

describe('endsAsking', () => {
  it('counts text after the last tool use that ends with a question', () => {
    expect(endsAsking([tool('Bash'), text('Tests pass.'), text('Should I push?')])).toBe(true)
    expect(endsAsking([text('Ready to deploy?'), { type: 'thinking' }])).toBe(true)
  })

  it('does not count a question the agent asked before it went on working', () => {
    expect(endsAsking([text('Shall I run the tests?'), tool('Bash')])).toBe(false)
    expect(endsAsking([text('Which one?'), tool('Edit'), text('Picked the first one and fixed it.')])).toBe(false)
  })

  it('reads only the prose after an AskUserQuestion call, whose questions wait on their own', () => {
    expect(endsAsking([text('Let me ask.'), tool('AskUserQuestion')])).toBe(false)
    expect(endsAsking([tool('AskUserQuestion'), text('Went with Postgres.')])).toBe(false)
    expect(endsAsking([tool('AskUserQuestion'), text('The answer was cut off; which database?')])).toBe(true)
  })

  it('finds nothing in a turn without text', () => {
    expect(endsAsking([])).toBe(false)
    expect(endsAsking([tool('Bash')])).toBe(false)
  })
})

describe('turnBlocks', () => {
  const reply = (content: unknown) => JSON.stringify({ type: 'assistant', message: { content } })

  it('reads text and tool use blocks of stored replies in order, skipping unreadable ones', () => {
    const blocks = turnBlocks([
      reply([{ type: 'text', text: 'Checking.' }]),
      '{not json',
      reply('plain'),
      reply([{ type: 'tool_use', name: 'AskUserQuestion', input: {} }, 'stray', { text: 'no type' }]),
    ])
    expect(blocks).toEqual([
      { type: 'text', text: 'Checking.', name: undefined },
      { type: 'tool_use', text: undefined, name: 'AskUserQuestion' },
    ])
    expect(endsAsking(blocks)).toBe(false)
  })
})
