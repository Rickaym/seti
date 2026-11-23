import { expect } from 'vitest'
import { closed, ofType, turnEnd, type Case } from './case.js'
import { echoOf } from './script.js'

const TIMED_OUT = /did not settle/

/** Interrupts and what happens to work the turn started, in the foreground and the background. */
export const INTERRUPT: Case[] = [
  {
    id: 'INT-1',
    title: 'an interrupt ends the running turn as interrupted, and the next input runs a new turn',
    proves: 'TURN-3; RuntimeSession.interrupt',
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [[{ say: 'working' }, { hold: true }]] }))
      run.send('one')
      await run.until((event) => event.type === 'message' && event.text === 'working', 'working')
      await run.interrupt()
      expect((await turnEnd(run, 1)).status).toBe('interrupted')
      run.send('two')
      expect(await turnEnd(run, 2)).toMatchObject({ status: 'ok', result: echoOf(['two']) })
      expect(ofType(run, 'turn.ended')).toHaveLength(2)
      await closed(run)
    },
  },
  {
    id: 'INT-2',
    title: 'the call running at an interrupt stops and never ends ok',
    proves: 'RuntimeSession.interrupt: the turn and every tool call it started stop',
    run: async (subject) => {
      const held = { tool: 'sh', args: { cmd: 'sleep 60' }, hold: true }
      const run = await subject.open(subject.rig({ turns: [[{ call: held }, { say: 'never said' }]] }))
      run.send('one')
      const started = await run.until((event) => event.type === 'tool.started', 'the held call')
      await run.interrupt()
      await turnEnd(run, 1)
      const callId = started.type === 'tool.started' ? started.call.callId : ''
      const ends = ofType(run, 'tool.ended').filter((end) => end.callId === callId)
      expect(ends.every((end) => end.status !== 'ok')).toBe(true)
      expect(ofType(run, 'message').map((m) => m.text)).not.toContain('never said')
      await closed(run)
    },
  },
  {
    id: 'INT-3',
    title: 'background work started before an interrupt keeps running and still reports its end',
    proves: 'RuntimeSession.interrupt: background work stays and is reported',
    skip: (profile) => (profile.background.jobs ? null : 'the runtime runs no background work'),
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [[{ job: 'build' }, { hold: true }]] }))
      run.send('one')
      const job = await run.until((event) => event.type === 'job.started', 'job.started')
      await run.interrupt()
      const end = await turnEnd(run, 1)
      expect(ofType(run, 'job.ended')).toEqual([])
      run.send('two')
      const done = await run.until((event) => event.type === 'job.ended', 'job.ended')
      expect(done).toMatchObject({ status: 'completed', jobId: job.type === 'job.started' ? job.jobId : '' })
      expect(run.events.indexOf(done)).toBeGreaterThan(run.events.indexOf(end))
      await closed(run)
    },
  },
  {
    id: 'INT-4',
    title: 'an interrupt while idle resolves and ends no turn',
    proves: 'RuntimeSession.interrupt',
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [] }))
      run.send('one')
      await turnEnd(run, 1)
      await run.interrupt()
      run.send('two')
      await turnEnd(run, 2)
      expect(ofType(run, 'turn.ended').map((end) => end.status)).toEqual(['ok', 'ok'])
      await closed(run)
    },
  },
  {
    id: 'INT-5',
    title: 'an interrupt the runtime refuses rejects with an error instead of hanging',
    proves: 'RuntimeSession.interrupt failure; TURN-3 close after the grace',
    run: async (subject) => {
      const rig = subject.rig({ turns: [[{ say: 'working' }, { hold: true }]], refuseInterrupt: true })
      const run = await subject.open(rig)
      run.send('one')
      await run.until((event) => event.type === 'message' && event.text === 'working', 'working')
      const refused = await run.interrupt().then(
        () => null,
        (e: unknown) => e,
      )
      expect(refused).toBeInstanceOf(Error)
      expect(String(refused)).not.toMatch(TIMED_OUT)
      await closed(run)
    },
  },
  {
    id: 'INT-6',
    title: 'stopping a background job ends it as stopped',
    proves: 'RuntimeSession.stopBackground',
    skip: (profile) => (profile.background.stop ? null : 'the runtime cannot stop background work'),
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [[{ job: 'server' }, { say: 'up' }]] }))
      run.send('one')
      await turnEnd(run, 1)
      const [job] = ofType(run, 'job.started')
      const stop = run.stopBackground(job?.jobId ?? '')
      expect(stop).not.toBeNull()
      await stop
      const end = await run.until((event) => event.type === 'job.ended', 'job.ended')
      expect(end).toMatchObject({ status: 'stopped', jobId: job?.jobId })
      await closed(run)
    },
  },
]
