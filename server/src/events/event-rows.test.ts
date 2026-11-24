import { type MessageRow, agentTexts, eventsOf, isAgentOutput, payloadEvents, rowEvents, toolEnds } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { assistant, toolResult, toolUse } from '../subtask-fixtures.js'

const row = (id: number, body: Pick<MessageRow, 'kind' | 'payload'>): MessageRow =>
  ({ id, task_id: 't', outward: [], created_at: '2026-11-20T09:00:00.000Z', ...body }) as MessageRow

describe('reading runtime rows as events', () => {
  it('projects a runtime row once and gives Seti rows none', () => {
    const said = row(1, assistant([{ type: 'text', text: 'Hi' }, toolUse('t1', 'Read', { file_path: 'a' })]))
    expect(rowEvents(said)).toBe(rowEvents(said))
    expect(rowEvents(said).map((event) => event.type)).toEqual(['message', 'tool.started'])
    expect(rowEvents(said).every(isAgentOutput)).toBe(true)
    expect(rowEvents(row(2, { kind: 'prompt', payload: { text: 'Go' } }))).toEqual([])
  })

  it('reads stored JSON text, and none from text that does not parse', () => {
    const { payload } = assistant([{ type: 'text', text: 'Done' }])
    expect(agentTexts(payloadEvents(JSON.stringify(payload), null))).toEqual(['Done'])
    expect(payloadEvents('{not json', null)).toEqual([])
  })

  it("keeps the agent's own text apart from a subagent's", () => {
    const events = [
      ...rowEvents(row(3, assistant([{ type: 'text', text: 'Sub' }], 't9'))),
      ...payloadEvents('{}', null),
    ]
    expect(agentTexts(events)).toEqual([])
    expect(eventsOf(events, 'vendor')).toHaveLength(1)
  })

  it("finds each call's latest end", () => {
    const ends = toolEnds([row(4, toolResult('t1', 'first')), row(5, toolResult('t1', 'again', { isError: true }))])
    expect(ends.get('t1')).toMatchObject({ status: 'error', result: { text: 'again' } })
  })
})
