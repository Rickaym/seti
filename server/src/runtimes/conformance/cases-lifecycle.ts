import { expect } from 'vitest'
import { closed, ofType, turnEnd, type Case } from './case.js'
import { within, type RunView } from './run.js'
import { echoOf } from './script.js'

/** The session id the session reported first. */
async function sessionIdOf(run: RunView): Promise<string> {
  const started = await run.until((event) => event.type === 'session.started', 'session.started')
  return started.type === 'session.started' ? started.sessionId : ''
}

/** Session lifecycle: open, first and later turns, close, resume, abort, turn starts. */
export const LIFECYCLE: Case[] = [
  {
    id: 'LC-1',
    title: 'realise and open resolve, and the session starts one process, through the launcher',
    proves: 'RuntimeAdapter.realise and open; RT-2 start through the launcher',
    run: async (subject) => {
      const rig = subject.rig({ turns: [[{ say: 'hello' }]] })
      const run = await within(subject.open(rig), 'open')
      expect(rig.spawns.length).toBeLessThanOrEqual(1)
      run.send('one')
      await turnEnd(run, 1)
      expect(rig.spawns).toHaveLength(1)
      await closed(run)
    },
  },
  {
    id: 'LC-2',
    title: 'the first input reports the session id first and ends its turn once, with the reply',
    proves: 'RT-2 resumable session id and turn end; TURN-17',
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [[{ say: 'working' }, { say: 'all done' }]] }))
      run.send('start')
      const end = await turnEnd(run, 1)
      const started = ofType(run, 'session.started')
      expect(started).toHaveLength(1)
      expect(started[0]?.sessionId).not.toBe('')
      expect(run.events.findIndex((event) => event.type === 'session.started')).toBeLessThan(
        run.events.findIndex((event) => event.type === 'message'),
      )
      expect(end).toMatchObject({ status: 'ok', result: 'all done' })
      expect(ofType(run, 'turn.ended')).toHaveLength(1)
      await closed(run)
    },
  },
  {
    id: 'LC-3',
    title: 'a later input runs a second turn on the same process and session',
    proves: 'TURN-1',
    run: async (subject) => {
      const rig = subject.rig({ turns: [] })
      const run = await subject.open(rig)
      run.send('first')
      await turnEnd(run, 1)
      run.send('second')
      expect((await turnEnd(run, 2)).result).toBe(echoOf(['second']))
      expect(ofType(run, 'session.started')).toHaveLength(1)
      expect(rig.spawns).toHaveLength(1)
      await closed(run)
    },
  },
  {
    id: 'LC-4',
    title: 'close ends the events within the bound, and closing twice is safe',
    proves: 'RuntimeSession.close',
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [] }))
      run.send('one')
      await turnEnd(run, 1)
      await closed(run)
      const seen = run.events.length
      run.close()
      expect(run.events).toHaveLength(seen)
    },
  },
  {
    id: 'LC-5',
    title: 'a session resumed by id after its process ended keeps its id and its conversation',
    proves: 'RT-2 resumable session id; TURN-15 restart keeps the session',
    run: async (subject) => {
      const rig = subject.rig({ turns: [[{ say: 'noted' }], [{ recall: true }]] })
      const first = await subject.open(rig)
      first.send('remember me')
      await turnEnd(first, 1)
      const id = await sessionIdOf(first)
      await closed(first)
      const second = await subject.open(rig, { resume: id })
      second.send('what came before')
      const end = await turnEnd(second, 1)
      expect(await sessionIdOf(second)).toBe(id)
      expect(end.result).toBe('remember me|what came before')
      await closed(second)
    },
  },
  {
    id: 'LC-6',
    title: 'aborting the controller given to realise ends the session like close',
    proves: 'RuntimeAdapter.realise abortController',
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [] }))
      run.send('one')
      await turnEnd(run, 1)
      run.abort()
      const outcome = await run.settled()
      expect(outcome === null || outcome instanceof Error).toBe(true)
    },
  },
  {
    id: 'LC-7',
    title: 'a turn start precedes its turn and names the turn its end names',
    proves: 'RT-6 turn boundaries',
    skip: (profile) => (profile.events.turnStart ? null : 'the runtime marks no turn start'),
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [[{ say: 'a' }], [{ say: 'b' }]] }))
      run.send('one')
      await turnEnd(run, 1)
      run.send('two')
      await turnEnd(run, 2)
      const starts = ofType(run, 'turn.started')
      const ends = ofType(run, 'turn.ended')
      expect(starts.map((start) => start.turnId)).toEqual(ends.map((end) => end.turnId))
      for (const start of starts) {
        const at = run.events.indexOf(start)
        const firstMessage = run.events.findIndex((event, i) => i > at && event.type === 'message')
        expect(at).toBeLessThan(firstMessage)
      }
      await closed(run)
    },
  },
]
