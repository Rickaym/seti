import type { ToolCall } from '@seti/shared'
import { expect, vi } from 'vitest'
import { closed, ofType, turnEnd, type Case } from './case.js'
import { settle } from './run.js'
import type { ScriptCall } from './script.js'
import type { NeutralHost } from './target.js'

/** How long a call's decision may follow its start: over ACP they are two messages. */
const DECISION_WAIT = { timeout: 5000, interval: 20 }

/** A host that allows every call and notes each call and how many effects had run when asked. */
function noting(effects: readonly string[]): { host: NeutralHost; asked: { call: ToolCall; before: number }[] } {
  const asked: { call: ToolCall; before: number }[] = []
  const host: NeutralHost = {
    decide: async (call) => {
      asked.push({ call, before: effects.length })
      return Promise.resolve({ allow: true })
    },
    ask: async () => Promise.resolve({}),
  }
  return { host, asked }
}

const SHELL: ScriptCall = { tool: 'sh', args: { cmd: 'rm -rf build' }, output: 'removed' }

/** The vendor's input with the value that holds the command replaced. */
const rewritten = (call: ToolCall, command: string): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(call.input as Record<string, unknown>).map(([key, value]) => [
      key,
      value === call.shell?.command ? command : value,
    ]),
  )

/** Permission asks: before any effect, deny with a message, rewrite, held decisions, no caching. */
export const PERMISSIONS: Case[] = [
  {
    id: 'PM-1',
    title: 'a shell call reaches the host as a neutral call before it runs',
    proves: 'RT-4 (draft): every call at a gate is decided; PERM-1',
    skip: (profile) => (profile.gated.shell ? null : 'the runtime decides no shell call before it runs'),
    run: async (subject) => {
      const rig = subject.rig({ turns: [[{ call: SHELL }, { say: 'done' }]] })
      const { host, asked } = noting(rig.effects)
      const run = await subject.open(rig, { host })
      run.send('go')
      await turnEnd(run, 1)
      expect(asked).toHaveLength(1)
      expect(asked[0]?.call).toMatchObject({ kind: 'shell', shell: { command: 'rm -rf build' } })
      expect(asked[0]?.before).toBe(0)
      expect(rig.effects).toHaveLength(1)
      await closed(run)
    },
  },
  {
    id: 'PM-2',
    title: 'an edit and a tool server call reach the host before they run',
    proves: 'RT-4 (draft); PERM-1',
    skip: (profile) => (profile.gated.edit || profile.gated.mcp ? null : 'the runtime decides no edit or tool call'),
    run: async (subject) => {
      const edit = { tool: 'patch', args: { path: 'a.txt', diff: '+b' }, output: 'ok' }
      const mcp = { tool: 'seti.send_message', args: { to: 'x' }, output: 'sent' }
      const rig = subject.rig({ turns: [[{ call: edit }, { call: mcp }]] })
      const { host, asked } = noting(rig.effects)
      const run = await subject.open(rig, { host })
      run.send('go')
      await turnEnd(run, 1)
      const wanted = [
        ...(subject.profile.gated.edit ? [{ kind: 'edit', before: 0 }] : []),
        ...(subject.profile.gated.mcp ? [{ kind: 'mcp', before: subject.profile.gated.edit ? 1 : 0 }] : []),
      ]
      expect(asked.map((each) => ({ kind: each.call.kind, before: each.before }))).toEqual(wanted)
      expect(asked.find((each) => each.call.kind === 'edit')?.call.edit?.changes[0]?.path ?? 'a.txt').toBe('a.txt')
      await closed(run)
    },
  },
  {
    id: 'PM-3',
    title: 'a denied call ends as denied with the message, runs nothing, and the turn goes on',
    proves: 'PERM-1 deny reaches the model as a message',
    skip: (profile) => (profile.gated.shell ? null : 'the runtime decides no shell call before it runs'),
    run: async (subject) => {
      const rig = subject.rig({ turns: [[{ call: SHELL }, { say: 'after' }]] })
      const host: NeutralHost = {
        decide: async () => Promise.resolve({ allow: false, message: 'Not in here.' }),
        ask: async () => Promise.resolve({}),
      }
      const run = await subject.open(rig, { host })
      run.send('go')
      const end = await turnEnd(run, 1)
      const [ended] = ofType(run, 'tool.ended')
      expect(ended?.status).toBe('denied')
      expect(ended?.result.text).toContain('Not in here.')
      expect(rig.effects).toEqual([])
      expect(end).toMatchObject({ status: 'ok', result: 'after' })
      await closed(run)
    },
  },
  {
    id: 'PM-4',
    title: 'an allow with changed input runs the call with the changed input',
    proves: 'GRD-8; Capabilities.gate.rewriteInput',
    skip: (profile, declared) =>
      profile.gated.shell && declared.gate.rewriteInput ? null : 'the runtime cannot rewrite a call',
    run: async (subject) => {
      const rig = subject.rig({ turns: [[{ call: SHELL }]] })
      const host: NeutralHost = {
        decide: async (call) => Promise.resolve({ allow: true, input: rewritten(call, 'echo kept') }),
        ask: async () => Promise.resolve({}),
      }
      const run = await subject.open(rig, { host })
      run.send('go')
      await turnEnd(run, 1)
      expect(rig.effects).toHaveLength(1)
      expect(rig.effects[0]).toContain('echo kept')
      expect(rig.effects[0]).not.toContain('rm -rf')
      await closed(run)
    },
  },
  {
    id: 'PM-5',
    title: 'a call waits for its decision, and an interrupt meanwhile aborts the decision and the turn',
    proves: 'TURN-3; SessionHost.decide signal',
    skip: (profile) => (profile.gated.shell ? null : 'the runtime decides no shell call before it runs'),
    run: async (subject) => {
      const signals: AbortSignal[] = []
      const host: NeutralHost = {
        decide: async (_call, signal) => {
          signals.push(signal)
          return new Promise(() => undefined)
        },
        ask: async () => Promise.resolve({}),
      }
      const rig = subject.rig({ turns: [[{ call: SHELL }]] })
      const run = await subject.open(rig, { host })
      run.send('go')
      await run.until((event) => event.type === 'tool.started', 'the call')
      await vi.waitFor(() => {
        expect(signals).toHaveLength(1)
      }, DECISION_WAIT)
      expect(ofType(run, 'tool.ended')).toEqual([])
      await run.interrupt()
      await turnEnd(run, 1)
      await settle()
      expect(signals[0]?.aborted).toBe(true)
      expect(rig.effects).toEqual([])
      await closed(run)
    },
  },
  {
    id: 'PM-7',
    title: 'a call held at an interrupt ends by the end of its turn, and never as ok',
    proves: 'RT-6 every call ends; TURN-3',
    skip: (profile) => (profile.gated.shell ? null : 'the runtime decides no shell call before it runs'),
    run: async (subject) => {
      const host: NeutralHost = {
        decide: async () => new Promise(() => undefined),
        ask: async () => Promise.resolve({}),
      }
      const run = await subject.open(subject.rig({ turns: [[{ call: SHELL }]] }), { host })
      run.send('go')
      const started = await run.until((event) => event.type === 'tool.started', 'the call')
      await settle()
      await run.interrupt()
      await turnEnd(run, 1)
      const callId = started.type === 'tool.started' ? started.call.callId : ''
      const ends = ofType(run, 'tool.ended').filter((end) => end.callId === callId)
      expect(ends.map((end) => end.status === 'ok')).toEqual([false])
      expect(run.events.indexOf(ends[0] ?? started)).toBeLessThan(run.events.findIndex((e) => e.type === 'turn.ended'))
      await closed(run)
    },
  },
  {
    id: 'PM-6',
    title: 'an identical call made again is decided again',
    proves: 'PERM-2; GRD-4: the runtime keeps no "always allow" of its own',
    skip: (profile) => (profile.gated.shell ? null : 'the runtime decides no shell call before it runs'),
    run: async (subject) => {
      const rig = subject.rig({ turns: [[{ call: SHELL }, { call: SHELL }]] })
      const { host, asked } = noting(rig.effects)
      const run = await subject.open(rig, { host })
      run.send('go')
      await turnEnd(run, 1)
      expect(asked.map((each) => each.before)).toEqual([0, 1])
      await closed(run)
    },
  },
]
