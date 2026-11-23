import type { RuntimeEvent } from '@seti/shared'
import { expect } from 'vitest'
import { closed, ofType, turnEnd, type Case } from './case.js'
import { echoOf, type Step } from './script.js'

const INNER: Step[] = [
  { say: 'reading the docs' },
  { call: { tool: 'cat', args: { path: 'docs/a.md' }, output: '# A' } },
  { say: 'docs say A' },
]

/** The subagent call the agent itself made, and the thread its events carry. */
function subagentOf(events: readonly RuntimeEvent[]): { callId: string; thread: string } {
  const started = events.find((event) => event.type === 'tool.started' && event.call.kind === 'subagent')
  const call = started?.type === 'tool.started' ? started.call : null
  expect(started?.thread).toBe('')
  expect(call?.subagent).toMatchObject({ label: 'research' })
  const thread = call?.subagent?.thread ?? ''
  expect(thread).not.toBe('')
  return { callId: call?.callId ?? '', thread }
}

/** Subagents in their own threads, plan updates, compaction, and models the runtime moves to. */
export const AGENTS: Case[] = [
  {
    id: 'SA-1',
    title: "a subagent's events carry its thread, and its call ends after them",
    proves: 'RT-6 threads; LVL-13 subagents',
    skip: (profile) => (profile.events.threads ? null : 'the runtime reports no subagent threads'),
    run: async (subject) => {
      const turn: Step[] = [{ subagent: { label: 'research', steps: INNER } }, { say: 'outer done' }]
      const run = await subject.open(subject.rig({ turns: [turn] }))
      run.send('go')
      expect((await turnEnd(run, 1)).result).toBe('outer done')
      const { callId, thread } = subagentOf(run.events)
      const inner = run.events.filter((event) => event.thread === thread)
      expect(ofType(run, 'message').map((m) => [m.thread, m.text])).toEqual([
        [thread, 'reading the docs'],
        [thread, 'docs say A'],
        ['', 'outer done'],
      ])
      expect(inner.map((event) => event.type)).toEqual(
        expect.arrayContaining(['message', 'tool.started', 'tool.ended']),
      )
      const ended = run.events.findIndex((event) => event.type === 'tool.ended' && event.callId === callId)
      expect(run.events[ended]).toMatchObject({ thread: '', status: 'ok' })
      expect(Math.max(...inner.map((event) => run.events.indexOf(event)))).toBeLessThan(ended)
      await closed(run)
    },
  },
  {
    id: 'SA-2',
    title: 'a background subagent reports its job start and end, joined to its call',
    proves: 'RuntimeSession background work; INT background subagents',
    skip: (profile) => (profile.background.subagents ? null : 'the runtime runs no subagent in the background'),
    run: async (subject) => {
      const turn: Step[] = [{ subagent: { label: 'research', steps: INNER, background: true } }, { say: 'waiting' }]
      const run = await subject.open(subject.rig({ turns: [turn] }))
      run.send('go')
      const done = await run.until((event) => event.type === 'job.ended', 'job.ended')
      const { callId } = subagentOf(run.events)
      const [started] = ofType(run, 'job.started')
      expect(started).toMatchObject({ callId, kind: 'subagent' })
      expect(done).toMatchObject({ jobId: started?.jobId, callId, status: 'completed' })
      const callEnd = run.events.findIndex((event) => event.type === 'tool.ended' && event.callId === callId)
      expect(callEnd).toBeGreaterThanOrEqual(0)
      expect(callEnd).toBeLessThan(run.events.indexOf(done))
      await turnEnd(run, 1)
      await closed(run)
    },
  },
  {
    id: 'PL-1',
    title: 'a plan change arrives as a plan call or a plan event with every item, in order',
    proves: 'ATT-4 plans; todos',
    skip: (profile) => (profile.events.plan ? null : 'the runtime reports no plan'),
    run: async (subject) => {
      const plan: Extract<Step, { plan: unknown }>['plan'] = [
        { text: 'read the code', status: 'completed' },
        { text: 'write the fix', status: 'in_progress' },
        { text: 'run the tests', status: 'pending' },
      ]
      const run = await subject.open(subject.rig({ turns: [[{ plan }, { say: 'planned' }]] }))
      run.send('go')
      await turnEnd(run, 1)
      const fromCall = ofType(run, 'tool.started').flatMap((event) =>
        event.call.kind === 'plan' ? [event.call.plan?.replace ?? []] : [],
      )
      const fromEvent = ofType(run, 'plan').map((event) => event.items)
      const lists = [...fromCall, ...fromEvent]
      expect(lists).toHaveLength(1)
      expect(lists[0]?.map((item) => ({ text: item.text, status: item.status }))).toEqual(plan)
      await closed(run)
    },
  },
  {
    id: 'CP-1',
    title: 'a compaction reports its start, then its end with trigger and size, and the session goes on',
    proves: 'RES compaction',
    skip: (profile) => (profile.events.compaction ? null : 'the runtime reports no compaction'),
    run: async (subject) => {
      const compact = { trigger: 'auto' as const, before: 150_000 }
      const run = await subject.open(subject.rig({ turns: [[{ compact }, { say: 'carried on' }]] }))
      run.send('one')
      expect((await turnEnd(run, 1)).status).toBe('ok')
      const phases = ofType(run, 'compaction')
      expect(phases[0]?.phase).toBe('started')
      expect(phases.find((event) => event.phase === 'done')).toMatchObject({ trigger: 'auto', before: 150_000 })
      run.send('two')
      expect((await turnEnd(run, 2)).result).toBe(echoOf(['two']))
      await closed(run)
    },
  },
  {
    id: 'MM-3',
    title: 'a model change the runtime makes by itself reports the model it left, the new one, and why',
    proves: 'RES-14 model fallback',
    skip: (profile) => (profile.events.modelFallback ? null : 'the runtime never changes model by itself'),
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [[{ say: 'a' }, { fallback: 'small-1' }, { say: 'b' }]] }))
      run.send('go')
      expect((await turnEnd(run, 1)).result).toBe('b')
      const [changed] = ofType(run, 'model.changed')
      expect(changed).toMatchObject({ thread: '', to: 'small-1' })
      expect(['fallback', 'refusal']).toContain(changed?.reason)
      expect(changed?.from).not.toBe('')
      expect(changed?.from).not.toBe('small-1')
      await closed(run)
    },
  },
]
