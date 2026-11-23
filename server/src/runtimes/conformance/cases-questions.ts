import { expect } from 'vitest'
import { closed, ofType, turnEnd, type Case } from './case.js'
import type { NeutralHost, Questions } from './target.js'

const ASK = {
  call: { tool: 'ask', args: { questions: [{ text: 'Which colour?', options: ['red', 'blue'] }] } },
}

/** Structured questions: they reach the user, the answers reach the runtime, interrupts end them. */
export const QUESTIONS: Case[] = [
  {
    id: 'Q-1',
    title: "a structured question reaches the host with its options, and the user's answer reaches the runtime",
    proves: 'LVL-8 the question tool; ATT asking',
    run: async (subject) => {
      const asked: Questions[] = []
      const host: NeutralHost = {
        decide: async () => Promise.resolve({ allow: true }),
        ask: async (questions) => {
          asked.push(questions)
          return Promise.resolve({ 'Which colour?': 'blue' })
        },
      }
      const run = await subject.open(subject.rig({ turns: [[ASK, { say: 'noted' }]] }), { host })
      run.send('go')
      await turnEnd(run, 1)
      expect(asked).toEqual([[expect.objectContaining({ text: 'Which colour?', options: ['red', 'blue'] })]])
      const [started] = ofType(run, 'tool.started')
      const [ended] = ofType(run, 'tool.ended')
      expect(started?.call.kind).toBe('question')
      expect(ended).toMatchObject({ status: 'ok', callId: started?.call.callId })
      expect(ended?.result.text).toContain('blue')
      await closed(run)
    },
  },
  {
    id: 'Q-2',
    title: 'an interrupt while a question waits ends the turn and aborts the question',
    proves: 'TURN-3',
    run: async (subject) => {
      const signals: AbortSignal[] = []
      const host: NeutralHost = {
        decide: async () => Promise.resolve({ allow: true }),
        ask: async (_questions, signal) => {
          signals.push(signal)
          return new Promise(() => undefined)
        },
      }
      const run = await subject.open(subject.rig({ turns: [[ASK]] }), { host })
      run.send('go')
      await run.until((event) => event.type === 'tool.started', 'the question')
      await run.interrupt()
      await turnEnd(run, 1)
      expect(signals.map((signal) => signal.aborted)).toEqual([true])
      await closed(run)
    },
  },
]
