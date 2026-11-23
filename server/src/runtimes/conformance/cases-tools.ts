import type { EventOf } from '@seti/shared'
import { expect } from 'vitest'
import { closed, ofType, turnEnd, type Case } from './case.js'
import { VARIED } from './script.js'

type Started = EventOf<'tool.started'>

/** The call of each kind in a run, by kind. */
const byKind = (calls: Started[]) => new Map(calls.map((started) => [started.call.kind, started.call]))

/** Tool calls: neutral kinds with their parts, results, one MCP identity, ends after the turn. */
export const TOOLS: Case[] = [
  {
    id: 'TL-1',
    title: "each call has its kind, the vendor's name and input, and the part its kind reads",
    proves: 'RT-6 tool kinds; design C.3 tool identity',
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [VARIED] }))
      run.send('go')
      await turnEnd(run, 1)
      const calls = byKind(ofType(run, 'tool.started'))
      expect(calls.get('shell')?.shell?.command).toBe('ls')
      expect(calls.get('read')?.read?.paths).toEqual(['README.md'])
      expect(calls.get('search')?.search?.pattern).toBe('TODO')
      expect(calls.get('web')?.web?.url).toBe('https://example.com/')
      expect(calls.get('edit')?.edit?.changes.map((change) => change.path)).toEqual(['README.md'])
      expect(calls.get('mcp')?.mcp).toEqual({ server: 'seti', tool: 'list_agents' })
      expect(calls.get('other')?.name).toContain('frobnicate')
      for (const started of ofType(run, 'tool.started')) {
        expect(started.call.name).not.toBe('')
        expect(typeof started.call.input).toBe('object')
      }
      await closed(run)
    },
  },
  {
    id: 'TL-2',
    title: 'a call ends ok with its output, and a failing call ends as an error',
    proves: 'RT-6 tool results',
    run: async (subject) => {
      const steps = [
        { call: { tool: 'sh', args: { cmd: 'true' }, output: 'fine' } },
        { call: { tool: 'sh', args: { cmd: 'false' }, output: 'boom', fails: true } },
      ]
      const run = await subject.open(subject.rig({ turns: [steps] }))
      run.send('go')
      await turnEnd(run, 1)
      const ends = ofType(run, 'tool.ended')
      expect(ends.map((end) => end.status)).toEqual(['ok', 'error'])
      expect(ends.map((end) => end.result.text)).toEqual(['fine', 'boom'])
      await closed(run)
    },
  },
  {
    id: 'TL-3',
    title: "a tool server's tool keeps one identity, server and tool, whatever the vendor calls it",
    proves: 'design 4.2: an MCP tool is the same identity on every runtime',
    run: async (subject) => {
      const call = { tool: 'my-server.do_thing', args: { n: 1 }, output: 'done' }
      const run = await subject.open(subject.rig({ turns: [[{ call }]] }))
      run.send('go')
      await turnEnd(run, 1)
      const [started] = ofType(run, 'tool.started')
      expect(started?.call).toMatchObject({ kind: 'mcp', mcp: { server: 'my-server', tool: 'do_thing' } })
      await closed(run)
    },
  },
  {
    id: 'TL-4',
    title: 'work that ends after its turn ended still joins the call that started it',
    proves: 'RT-6 events join by call id; items can outlive their turn',
    skip: (profile) => (profile.background.jobs ? null : 'the runtime runs no background work'),
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [[{ job: 'watch' }, { say: 'watching' }]] }))
      run.send('one')
      const first = await turnEnd(run, 1)
      run.send('two')
      const ended = await run.until((event) => event.type === 'job.ended', 'job.ended')
      const callId = ended.type === 'job.ended' ? ended.callId : null
      const started = ofType(run, 'tool.started').find((event) => event.call.callId === callId)
      expect(started).toBeDefined()
      expect(run.events.indexOf(started ?? ended)).toBeLessThan(run.events.indexOf(first))
      expect(run.events.indexOf(ended)).toBeGreaterThan(run.events.indexOf(first))
      await closed(run)
    },
  },
]
