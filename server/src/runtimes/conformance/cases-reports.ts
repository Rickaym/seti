import type { RuntimeEvent } from '@seti/shared'
import { expect } from 'vitest'
import type { SessionMessage, SessionReport } from '../adapter.js'
import { closed, turnEnd, type Case } from './case.js'
import { isTurnEnd, type RunView } from './run.js'

/** The message reports of the session, in order. */
const messages = (run: RunView): SessionMessage[] =>
  run.reports.filter((report): report is SessionMessage => report.type === 'message')

/** The states the session reported for one input, in order. */
const statesOf = (run: RunView, id: string): string[] =>
  run.reports.flatMap((report) => (report.type === 'input' && report.id === id ? [report.state] : []))

/** The report is the input's in that state. */
const inputIs =
  (id: string, state: string) =>
  (report: SessionReport): boolean =>
    report.type === 'input' && report.id === id && report.state === state

/** The agent's own text, on its own thread. */
const agentText = (event: RuntimeEvent) => event.type === 'message' && event.role === 'agent'

/** What the session half reads beside the events: inputs taken, the agent at work, input states. */
export const REPORTS: Case[] = [
  {
    id: 'RP-1',
    title: "the report of a turn's end names the inputs the turn took",
    proves: 'SessionMessage.delivered; TURN-17 answered inputs',
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [[{ say: 'a' }], [{ say: 'b' }]] }))
      const one = run.send('one')
      await turnEnd(run, 1)
      const two = run.send('two')
      await turnEnd(run, 2)
      const ends = messages(run).filter((report) => report.events.some(isTurnEnd))
      expect(ends.map((report) => report.delivered)).toEqual([[one], [two]])
      expect(
        messages(run)
          .filter((report) => !report.events.some(isTurnEnd))
          .flatMap((r) => r.delivered),
      ).toEqual([])
      await closed(run)
    },
  },
  {
    id: 'RP-2',
    title: "the agent's own output is reported as the agent at work, a subagent's as work only",
    proves: 'SessionMessage.work and byAgent',
    skip: (profile) => (profile.events.threads ? null : 'the runtime reports no subagent threads'),
    run: async (subject) => {
      const inner = [{ say: 'inside' }]
      const run = await subject.open(
        subject.rig({ turns: [[{ subagent: { label: 'research', steps: inner } }, { say: 'outside' }]] }),
      )
      run.send('go')
      await turnEnd(run, 1)
      const own = messages(run).filter((report) => report.events.some((e) => agentText(e) && e.thread === ''))
      const sub = messages(run).filter((report) => report.events.some((e) => agentText(e) && e.thread !== ''))
      expect(own.map((report) => [report.work, report.byAgent])).toEqual([[true, true]])
      expect(sub.map((report) => [report.work, report.byAgent])).toEqual([[true, false]])
      await closed(run)
    },
  },
  {
    id: 'RP-3',
    title: 'an input sent during a turn is reported queued, then taken by a later turn or dropped when taken back',
    proves: 'InputReport; TURN-11',
    skip: (profile) => (profile.input.reports ? null : 'the runtime does not report what became of an input'),
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [[{ say: 'busy' }, { hold: true }]] }))
      const first = run.send('one')
      await run.until((event) => event.type === 'message' && event.text === 'busy', 'busy')
      const kept = run.send('two')
      await run.untilReport(inputIs(kept, 'queued'), 'two queued')
      if (subject.profile.input.retract) {
        const dropped = run.send('three')
        await run.untilReport(inputIs(dropped, 'queued'), 'three queued')
        expect(await run.retract(dropped)).toBe(true)
        await run.untilReport(inputIs(dropped, 'cancelled'), 'three dropped')
        expect(statesOf(run, dropped)).not.toContain('started')
      }
      await run.interrupt()
      await turnEnd(run, 2)
      expect(statesOf(run, first)).toContain('started')
      const states = statesOf(run, kept).filter((state) => state !== 'other')
      expect(states).toEqual(['queued', 'started'])
      await closed(run)
    },
  },
]
