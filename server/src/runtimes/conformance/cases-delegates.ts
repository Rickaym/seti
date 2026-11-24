import { expect } from 'vitest'
import { closed, ofType, turnEnd, type Case } from './case.js'
import type { ScriptCall } from './script.js'

/** A Seti tool that waits on another agent, as a delegate's wait or a second opinion does. */
const WAIT: ScriptCall = {
  tool: 'seti.wait_for_agent',
  args: { task: 'helper' },
  output: 'helper ended: 3 files changed',
}

const NOTE_WAIT_MS = 10_000

/** Resolves once the rig noted a line that starts so, polling, and gives up after a while. */
async function noted(effects: () => readonly string[], start: string): Promise<void> {
  const seen = () => effects().some((line) => line.startsWith(start))
  const until = Date.now() + NOTE_WAIT_MS
  while (!seen() && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  expect(seen(), `the rig noted ${start}`).toBe(true)
}

/**
 * A Seti agent as a subagent: the runtime's part is a tool server call that waits. SA-1 and SA-2
 * restated for it, so they hold on runtimes with no subagents of their own.
 */
export const DELEGATES: Case[] = [
  {
    id: 'DG-1',
    title: "a tool server call that answers late ends ok on the agent's own thread, before the reply",
    proves: 'SA-1 for a Seti agent as a subagent: its result reaches the caller inside its own turn',
    run: async (subject) => {
      const turn = [{ say: 'asking the helper' }, { call: { ...WAIT, delayMs: 1500 } }, { say: 'the helper is done' }]
      const run = await subject.open(subject.rig({ turns: [turn] }))
      run.send('go')
      expect((await turnEnd(run, 1)).status).toBe('ok')
      const started = ofType(run, 'tool.started').find((event) => event.call.kind === 'mcp')
      expect(started?.thread).toBe('')
      const end = ofType(run, 'tool.ended').find((event) => event.callId === started?.call.callId)
      expect(end).toMatchObject({ thread: '', status: 'ok', result: { text: WAIT.output } })
      const reply = run.events.findIndex((event) => event.type === 'message' && event.text === 'the helper is done')
      expect(end === undefined ? -1 : run.events.indexOf(end)).toBeLessThan(reply)
      expect(end).toBeDefined()
      await closed(run)
    },
  },
  {
    id: 'DG-2',
    title: 'an interrupt while a tool server call waits ends the turn and cancels the call at its server',
    proves: 'SA-2 for a Seti agent as a subagent: an interrupted caller stops waiting, and Seti hears it',
    run: async (subject) => {
      const rig = subject.rig({
        turns: [[{ say: 'waiting' }, { call: { ...WAIT, hold: true } }, { say: 'never said' }]],
      })
      const run = await subject.open(rig)
      run.send('go')
      const started = await run.until(
        (event) => event.type === 'tool.started' && event.call.kind === 'mcp',
        'the waiting call',
      )
      await subject.within(
        noted(() => rig.effects, `${WAIT.tool} `),
        'the call at the tool server',
      )
      await run.interrupt()
      await turnEnd(run, 1)
      const callId = started.type === 'tool.started' ? started.call.callId : ''
      expect(ofType(run, 'tool.ended').filter((end) => end.callId === callId && end.status === 'ok')).toEqual([])
      await subject.within(
        noted(() => rig.effects, `cancelled ${WAIT.tool}`),
        'the cancel at the tool server',
      )
      expect(ofType(run, 'message').map((m) => m.text)).not.toContain('never said')
      await closed(run)
    },
  },
]
