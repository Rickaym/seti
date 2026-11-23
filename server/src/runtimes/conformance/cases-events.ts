import type { RuntimeEvent, ToolKind } from '@seti/shared'
import { expect } from 'vitest'
import { closed, ofType, turnEnd, type Case } from './case.js'
import type { Step } from './script.js'

const EVENT_TYPES = {
  'session.started': true,
  'turn.started': true,
  message: true,
  reasoning: true,
  'tool.started': true,
  'tool.progress': true,
  'tool.ended': true,
  plan: true,
  'job.started': true,
  'job.progress': true,
  'job.updated': true,
  'job.ended': true,
  'background.changed': true,
  usage: true,
  compaction: true,
  'model.changed': true,
  'policy.denied': true,
  'change.published': true,
  notice: true,
  'turn.ended': true,
  vendor: true,
} satisfies Record<RuntimeEvent['type'], true>

const TOOL_KINDS = {
  shell: true,
  read: true,
  edit: true,
  search: true,
  web: true,
  mcp: true,
  subagent: true,
  question: true,
  plan: true,
  think: true,
  other: true,
} satisfies Record<ToolKind, true>

/** A turn that uses most of what a runtime reports: reasoning, text, and calls of several kinds. */
const VARIED: Step[] = [
  { think: 'plan the work' },
  { say: 'looking around' },
  { call: { tool: 'sh', args: { cmd: 'ls' }, output: 'README.md' } },
  { call: { tool: 'cat', args: { path: 'README.md' }, output: '# Readme' } },
  { call: { tool: 'grep', args: { pattern: 'TODO' }, output: 'none' } },
  { call: { tool: 'fetch', args: { url: 'https://example.com/' }, output: 'page' } },
  { call: { tool: 'patch', args: { path: 'README.md', diff: '-a\n+b\n' }, output: 'patched' } },
  { call: { tool: 'seti.list_agents', args: {}, output: '[]' } },
  { call: { tool: 'frobnicate', args: { level: 3 }, output: 'frobbed' } },
  { say: 'all done' },
]

const known = (type: string): boolean => Object.hasOwn(EVENT_TYPES, type)
const kindKnown = (kind: string): boolean => Object.hasOwn(TOOL_KINDS, kind)

/** Events: closed lists, ordering, text, usage, broken and unknown messages, stable projection. */
export const EVENTS: Case[] = [
  {
    id: 'EV-1',
    title: 'every event has version 1, a thread, and a type and tool kind from the closed lists',
    proves: 'RT-6 closed lists',
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [VARIED] }))
      run.send('go')
      await turnEnd(run, 1)
      for (const event of run.events) {
        expect(event.v).toBe(1)
        expect(typeof event.thread).toBe('string')
        expect(known(event.type), event.type).toBe(true)
      }
      for (const started of ofType(run, 'tool.started')) {
        expect(kindKnown(started.call.kind), started.call.kind).toBe(true)
      }
      await closed(run)
    },
  },
  {
    id: 'EV-2',
    title: 'each tool end follows its start by call id, and foreground calls end before their turn',
    proves: 'RT-2 tool start and end; RT-6',
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [VARIED] }))
      run.send('go')
      const end = await turnEnd(run, 1)
      const ends = ofType(run, 'tool.ended')
      expect(ends).toHaveLength(7)
      for (const toolEnd of ends) {
        const start = run.events.findIndex((e) => e.type === 'tool.started' && e.call.callId === toolEnd.callId)
        expect(start).toBeGreaterThanOrEqual(0)
        expect(start).toBeLessThan(run.events.indexOf(toolEnd))
        expect(run.events.indexOf(toolEnd)).toBeLessThan(run.events.indexOf(end))
      }
      await closed(run)
    },
  },
  {
    id: 'EV-3',
    title: "the agent's text arrives as agent messages, and its reasoning where the runtime shows it",
    proves: 'RT-6 messages and reasoning',
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [VARIED] }))
      run.send('go')
      await turnEnd(run, 1)
      const texts = ofType(run, 'message').flatMap((m) => (m.role === 'agent' && m.thread === '' ? [m.text] : []))
      expect(texts).toEqual(['looking around', 'all done'])
      if (subject.profile.events.reasoning) {
        expect(ofType(run, 'reasoning').map((r) => r.text)).toEqual(['plan the work'])
      }
      await closed(run)
    },
  },
  {
    id: 'EV-4',
    title: "a turn's end carries its tokens, and its cost where the runtime reports one",
    proves: 'TURN-17',
    skip: (profile) =>
      profile.usage.tokens || profile.usage.costUsd === 'reported' ? null : 'the runtime reports no usage',
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [VARIED] }))
      run.send('go')
      const end = await turnEnd(run, 1)
      if (subject.profile.usage.tokens) {
        expect(end.usage?.input).toBeGreaterThanOrEqual(0)
        expect(end.usage?.output).toBeGreaterThan(0)
      }
      if (subject.profile.usage.costUsd === 'reported') {
        expect(Number.isFinite(end.costUsd), 'turn.ended costUsd').toBe(true)
        expect(end.costUsd).toBeGreaterThanOrEqual(0)
      }
      await closed(run)
    },
  },
  {
    id: 'EV-5',
    title: 'a known message in a broken shape becomes one unreadable vendor event among intact rows',
    proves: 'RT-6 a message with no mapping MUST NOT break the rows around it',
    run: async (subject) => {
      const run = await subject.open(
        subject.rig({ turns: [[{ say: 'before' }, { malformed: true }, { say: 'after' }]] }),
      )
      run.send('go')
      const end = await turnEnd(run, 1)
      expect(ofType(run, 'vendor').filter((v) => v.unreadable === true)).toHaveLength(1)
      expect(ofType(run, 'message').map((m) => m.text)).toEqual(expect.arrayContaining(['before', 'after']))
      expect(end.status).toBe('ok')
      await closed(run)
    },
  },
  {
    id: 'EV-6',
    title: 'a message of an unknown type becomes one quiet vendor event and nothing else',
    proves: 'RT-6 unmapped messages are vendor',
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [[{ unknown: 'shiny_new_thing' }, { say: 'fine' }]] }))
      run.send('go')
      await turnEnd(run, 1)
      const quiet = run.projections().filter((p) => p.live.some((e) => e.type === 'vendor' && e.name.includes('shiny')))
      expect(quiet).toHaveLength(1)
      expect(quiet[0]?.live).toEqual([expect.objectContaining({ type: 'vendor', thread: '' })])
      expect(quiet[0]?.live[0]).not.toHaveProperty('unreadable')
      await closed(run)
    },
  },
  {
    id: 'EV-7',
    title: 'projection is stateless and survives storage: the same message always gives the same events',
    proves: 'RT-6 stored unchanged, events computed (wire equals stored projection)',
    run: async (subject) => {
      const run = await subject.open(
        subject.rig({ turns: [VARIED, [{ malformed: true }, { unknown: 'later_thing' }]] }),
      )
      run.send('go')
      await turnEnd(run, 1)
      run.send('more')
      await turnEnd(run, 2)
      for (const projection of run.projections()) {
        expect(projection.again).toEqual(projection.live)
        expect(projection.stored).toEqual(projection.live)
      }
      await closed(run)
    },
  },
]
