import { closingQuestion, type TurnBlock } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { turnBlocks } from './turn-asking.js'

const text = (value: string): TurnBlock => ({ type: 'text', text: value })
const tool = (name: string): TurnBlock => ({ type: 'tool_use', name })

describe('closingQuestion', () => {
  it('counts text after the last tool use that ends with a question', () => {
    expect(closingQuestion([tool('Bash'), text('Tests pass.'), text('Should I push?')]).asks).toBe(true)
    expect(closingQuestion([text('Ready to deploy?'), { type: 'thinking' }]).asks).toBe(true)
  })

  it('does not count a question the agent asked before it went on working', () => {
    expect(closingQuestion([text('Shall I run the tests?'), tool('Bash')]).asks).toBe(false)
    expect(closingQuestion([text('Which one?'), tool('Edit'), text('Picked the first one and fixed it.')]).asks).toBe(
      false,
    )
  })

  it('reads only the prose after an AskUserQuestion call, whose questions wait on their own', () => {
    expect(closingQuestion([text('Let me ask.'), tool('AskUserQuestion')]).asks).toBe(false)
    expect(closingQuestion([tool('AskUserQuestion'), text('Went with Postgres.')]).asks).toBe(false)
    expect(closingQuestion([tool('AskUserQuestion'), text('The answer was cut off; which database?')]).asks).toBe(true)
  })

  it('finds nothing in a turn without text', () => {
    expect(closingQuestion([]).asks).toBe(false)
    expect(closingQuestion([tool('Bash')]).asks).toBe(false)
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
    expect(closingQuestion(blocks).asks).toBe(false)
  })
})
