import { COMPACT_DEFAULTS } from '@seti/shared'
import type { CodexToolServer } from '../../codex-tool-servers.js'
import type { SessionSpec } from '../../session-spec.js'
import type { UserSkill } from '../../user-skills.js'
import type { RuntimeShapes, SessionInput } from '../adapter.js'
import { runOneShot, type OneShot, type OneShotResult } from '../one-shot.js'
import { CASE_BOUND_MS, Channel, Run, within, type RunView } from './run.js'
import type { Script } from './script.js'
import type { ConformanceTarget, NeutralHost, Profile, Rig } from './target.js'

/** The folder every suite session works in; no adapter may touch it, since the runtime is fake. */
export const SUITE_CWD = '/work/conformance'

const NO_SKILLS: readonly UserSkill[] = []
const NO_SERVERS: readonly CodexToolServer[] = []

/** A spec with nothing in it but what a case varies; no adapter reads the sandbox stamp. */
export function specFor<Id extends string>(runtime: Id, resume: string | null): SessionSpec<Id> {
  return {
    runtime,
    taskId: 'conformance-task',
    title: 'Conformance',
    resume,
    cwd: SUITE_CWD,
    dirs: [],
    mode: 'default',
    instructions: { append: '' },
    rules: { allow: [], ask: [], deny: [] },
    deniedToolServers: [],
    toolServers: { shared: [], borrowed: { names: [], digest: '' }, signedIn: [], tokens: [] },
    setiControl: 'full',
    compaction: COMPACT_DEFAULTS,
    setiDreams: false,
    // The stamp is read only by the setup key, never by an adapter.
    sandbox: {} as SessionSpec['sandbox'],
    account: null,
    // The vendor part of a spec is the runtime's own; no Codex program, so a bench names its own.
    vendor: (runtime === 'codex'
      ? { binary: '', model: null, effort: null, skills: NO_SKILLS, servers: NO_SERVERS }
      : { plugins: [] }) as SessionSpec<Id>['vendor'],
  }
}

/** Allows every call as asked. */
const ALLOW_ALL: NeutralHost = {
  decide: async () => Promise.resolve({ allow: true }),
  ask: async (questions) =>
    Promise.resolve(Object.fromEntries(questions.map((question) => [question.text, question.options[0] ?? '']))),
}

/** How a case opens a session. */
interface OpenOptions {
  resume?: string | null
  host?: NeutralHost
}

/** A target with its runtime's shapes hidden: what every case drives. */
export interface Subject {
  readonly id: string
  readonly profile: Profile
  rig: (script: Script) => Rig
  /** Realises a spec on the rig's launcher and opens the session; rejects as the adapter does. */
  open: (rig: Rig, options?: OpenOptions) => Promise<RunView>
  /** The promise's value, or a rejection once it took longer than this runtime may take. */
  within: <T>(promise: Promise<T>, label: string) => Promise<T>
  /** Asks the runtime's one-shot on the rig's launcher; absent where the target has none. */
  oneShot?: (rig: Rig, prompt: string) => Promise<OneShotResult>
}

/** A one-shot call on the rig, bounded as a case is. */
function oneShotOf(oneShot: { runner: OneShot; model: string }, bound: number) {
  return async (rig: Rig, prompt: string) =>
    runOneShot(
      oneShot.runner,
      {
        model: oneShot.model,
        system: 'Answer in one line.',
        prompt,
        cwd: SUITE_CWD,
        maxOutputTokens: 4000,
        budgetUsd: 1,
      },
      rig.launcher,
      { timeoutMs: bound, signal: new AbortController().signal },
    )
}

/** The subject the cases drive for one target. */
export function subjectOf<S extends RuntimeShapes, Id extends string>(target: ConformanceTarget<S, Id>): Subject {
  const bound = target.boundMs ?? CASE_BOUND_MS
  return {
    id: target.adapter.id,
    profile: target.profile,
    rig: target.rig,
    open: async (rig, options = {}) => {
      const controller = new AbortController()
      const host = target.host(options.host ?? ALLOW_ALL)
      const realised = await target.adapter.realise(
        specFor(target.adapter.id, options.resume ?? null),
        rig.launcher,
        host,
        controller,
      )
      const inputs = new Channel<SessionInput>()
      const session = await target.adapter.open(realised, inputs, null)
      return new Run(session, target.adapter.project, inputs, { controller, bound }).start()
    },
    within: async (promise, label) => within(promise, label, bound),
    ...(target.oneShot === undefined ? {} : { oneShot: oneShotOf(target.oneShot, bound) }),
  }
}
