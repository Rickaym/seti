import { expect } from 'vitest'
import { closed, ofType, type Case } from './case.js'
import { isTurnEnd, type RunView } from './run.js'
import type { Subject } from './subject.js'
import type { NeutralHost, Rig } from './target.js'

/** Resolves once the signal aborts. */
const abortOf = async (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
    }
    signal.addEventListener('abort', () => {
      resolve()
    })
  })

/** A host that kills the process while it holds a decision, and notes when that decision aborts. */
function killing(rig: Rig): { host: NeutralHost; aborted: Promise<void> } {
  let seen: (() => void) | null = null
  const aborted = new Promise<void>((resolve) => {
    seen = resolve
  })
  const host: NeutralHost = {
    decide: async (_call, signal) => {
      rig.crash(137)
      await abortOf(signal)
      seen?.()
      return { allow: false, message: 'the process is gone' }
    },
    ask: async () => Promise.resolve({}),
  }
  return { host, aborted }
}

/**
 * Opens a session that should not start and sends it an input. Returns the Error it ended with:
 * `open` rejecting, or the events failing before any turn. Fails if a turn runs instead.
 */
export async function refusal(subject: Subject, rig: Rig, resume: string | null = null): Promise<Error> {
  let run: RunView
  try {
    run = await subject.within(subject.open(rig, { resume }), 'open')
  } catch (e) {
    expect(e).toBeInstanceOf(Error)
    return e instanceof Error ? e : new Error(String(e))
  }
  run.send('hello')
  const ran = await run.until(isTurnEnd, 'the refusal').then(
    () => true,
    () => false,
  )
  expect(ran).toBe(false)
  expect(run.outcome).toBeInstanceOf(Error)
  expect(ofType(run, 'session.started')).toEqual([])
  return run.outcome ?? new Error('the session ended cleanly')
}

/** Failure modes: each surfaces as a defined error before the bound, never as a hang. */
export const FAILURES: Case[] = [
  {
    id: 'FL-1',
    title: 'a process that dies mid-turn ends the events with an Error and aborts a waiting decision',
    proves: 'RES: a runtime that dies is reported, never waited on',
    run: async (subject) => {
      const run = await subject.open(subject.rig({ turns: [[{ say: 'working' }, { exit: 3 }, { say: 'never' }]] }))
      run.send('go')
      const outcome = await run.settled()
      expect(outcome).toBeInstanceOf(Error)
      expect(outcome?.message).toMatch(/\b3\b/)
      expect(ofType(run, 'turn.ended')).toEqual([])
      if (subject.profile.gated.shell) {
        const rig = subject.rig({ turns: [[{ call: { tool: 'sh', args: { cmd: 'make' } } }]] })
        const { host, aborted } = killing(rig)
        const killed = await subject.open(rig, { host })
        killed.send('go')
        await subject.within(aborted, "the held decision's signal")
        expect(await killed.settled()).toBeInstanceOf(Error)
        expect(rig.effects).toEqual([])
      }
    },
  },
  {
    id: 'FL-2',
    title: 'output that is no message becomes an unreadable vendor event or an Error, and later lines arrive',
    proves: 'RT-6: nothing the runtime writes is dropped in silence or hangs the session',
    skip: (profile) => (profile.parsesOutput ? null : "the vendor's library reads the runtime's output"),
    run: async (subject) => {
      const steps = [{ say: 'before' }, { garbage: 'warning: not a message {' }, { say: 'after' }]
      const run = await subject.open(subject.rig({ turns: [steps] }))
      run.send('go')
      const ended = await run.until(isTurnEnd, 'the turn').then(
        () => null,
        (e: unknown) => e,
      )
      if (ended === null) {
        expect(ofType(run, 'vendor').filter((event) => event.unreadable === true)).toHaveLength(1)
        const said = ofType(run, 'message').filter((message) => message.role === 'agent')
        expect(said.map((message) => message.text)).toEqual(['before', 'after'])
        await closed(run)
      } else {
        expect(run.outcome).toBeInstanceOf(Error)
      }
    },
  },
  {
    id: 'FL-3',
    title: 'a runtime that goes silent mid-turn, even one that ignores the signal to stop, still closes',
    proves: 'RuntimeSession.close; RES: no hang on a silent runtime',
    run: async (subject) => {
      for (const deaf of [false, true]) {
        const run = await subject.open(subject.rig({ turns: [[{ say: 'thinking' }, { hold: true }]], deaf }))
        run.send('go')
        await run.until((event) => event.type === 'message', 'the first message')
        await closed(run)
      }
    },
  },
  {
    id: 'FL-4',
    title: 'a start that is refused rejects with an Error before any event: spawn throws, unknown resume, early exit',
    proves: 'RES; RT-8: a session that cannot start says so',
    run: async (subject) => {
      await refusal(subject, subject.rig({ turns: [], launcher: { spawn: 'throws' } }))
      await refusal(subject, subject.rig({ turns: [] }), 'no-such-session')
      expect((await refusal(subject, subject.rig({ turns: [], exitAtStart: 9 }))).message).toMatch(/\b9\b/)
    },
  },
]
