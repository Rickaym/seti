import { expect } from 'vitest'
import { closed, ofType, turnEnd, type Case } from './case.js'
import { settle } from './run.js'
import { echoOf } from './script.js'

/** The inputs a run's turns answered, in order, from the replies that say them back. */
const heard = (results: string[]): string[] =>
  results.flatMap((result) => result.replace(/^heard: /, '').split(/\||\n+/)).filter((text) => text !== '')

/** Input sent during a turn: it joins or waits, is taken back while queued, and keeps its order. */
export const INPUT: Case[] = [
  {
    id: 'IN-1',
    title: 'input sent during a turn joins it at its next step, or runs next, as the runtime declares',
    proves: 'TURN-1',
    run: async (subject) => {
      const script = { turns: [[{ say: 'working' }, { awaitInput: true as const }, { recall: true as const }]] }
      const run = await subject.open(subject.rig(script))
      run.send('one')
      await run.until((event) => event.type === 'message' && event.text === 'working', 'working')
      run.send('two')
      const first = await turnEnd(run, 1)
      if (subject.profile.input.steer === 'next_step') {
        expect(first.result).toBe('one|two')
      } else {
        expect((await turnEnd(run, 2)).result).toBe(echoOf(['two']))
      }
      await closed(run)
    },
  },
  {
    id: 'IN-2',
    title: 'a queued input is taken back before the agent reads it, and not after',
    proves: 'TURN-11; RuntimeSession.retract',
    skip: (profile) => (profile.input.retract ? null : 'the runtime cannot take input back'),
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [[{ say: 'busy' }, { hold: true }]] }))
      const read = run.send('one')
      await run.until((event) => event.type === 'message' && event.text === 'busy', 'busy')
      const waiting = run.send('two')
      if (subject.profile.input.reports) {
        await run.untilReport((r) => r.type === 'input' && r.id === waiting && r.state === 'queued', 'queued')
      } else {
        await settle()
      }
      expect(await run.retract(waiting)).toBe(true)
      expect(await run.retract(read)).toBe(false)
      await run.interrupt()
      await turnEnd(run, 1)
      run.send('three')
      expect((await turnEnd(run, 2)).result).toBe(echoOf(['three']))
      await closed(run)
    },
  },
  {
    id: 'IN-3',
    title: 'inputs reach the runtime in the order sent, each once',
    proves: 'TURN-1',
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [] }))
      for (const text of ['a', 'b', 'c']) {
        run.send(text)
      }
      await run.until((event) => event.type === 'turn.ended' && heard([event.result]).includes('c'), 'input c')
      expect(heard(ofType(run, 'turn.ended').map((end) => end.result))).toEqual(['a', 'b', 'c'])
      await closed(run)
    },
  },
]
