import { expect } from 'vitest'
import { closed, ofType, turnEnd, type Case } from './case.js'
import { settle, type RunView } from './run.js'
import { echoOf } from './script.js'

/** The session id the session reported first. */
async function sessionIdOf(run: RunView): Promise<string> {
  const started = await run.until((event) => event.type === 'session.started', 'session.started')
  return started.type === 'session.started' ? started.sessionId : ''
}

/** How long a resumed runtime gets to report what it reports on its own before any input. */
const QUIET_MS = 1000

/** Reports that would mark the agent at work: its own output, or a session start. */
const workReports = (run: RunView) =>
  run.reports.filter(
    (report) =>
      report.type === 'message' && (report.byAgent || report.events.some((e) => e.type === 'session.started')),
  )

/** Session lifecycle: open, first and later turns, close, resume, abort, turn starts. */
export const LIFECYCLE: Case[] = [
  {
    id: 'LC-1',
    title: 'realise and open resolve, and the session starts one process, through the launcher',
    proves: 'RuntimeAdapter.realise and open; RT-2 start through the launcher',
    run: async (subject) => {
      const rig = subject.rig({ turns: [[{ say: 'hello' }]] })
      const run = await subject.within(subject.open(rig), 'open')
      expect(rig.spawns.length).toBeLessThanOrEqual(1)
      run.send('one')
      await turnEnd(run, 1)
      expect(rig.spawns).toHaveLength(1)
      await closed(run)
    },
  },
  {
    id: 'LC-2',
    title: 'the session id comes before the first turn, which ends once, with the reply',
    proves: 'RT-2 resumable session id and turn end; TURN-17',
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [[{ say: 'working' }, { say: 'all done' }]] }))
      run.send('start')
      const end = await turnEnd(run, 1)
      const ids = new Set(ofType(run, 'session.started').map((started) => started.sessionId))
      expect([...ids]).toHaveLength(1)
      expect(ids.has('')).toBe(false)
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
      expect(new Set(ofType(run, 'session.started').map((started) => started.sessionId)).size).toBe(1)
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
  {
    id: 'LC-8',
    title: 'a resumed session reports no work and no session start until its first input',
    proves: 'SessionMessage.byAgent; TURN-15 a restart leaves an idle agent idle',
    run: async (subject) => {
      const rig = subject.rig({ turns: [[{ say: 'noted' }], [{ say: 'again' }]] })
      const first = await subject.open(rig)
      first.send('one')
      await turnEnd(first, 1)
      const id = await sessionIdOf(first)
      await closed(first)
      const second = await subject.open(rig, { resume: id })
      await settle()
      await new Promise((resolve) => {
        setTimeout(resolve, QUIET_MS)
      })
      expect(workReports(second)).toEqual([])
      second.send('two')
      await turnEnd(second, 1)
      expect(ofType(second, 'session.started').map((started) => started.sessionId)).toEqual([id])
      await closed(second)
    },
  },
]
