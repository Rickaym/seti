import { COMPACT_DEFAULTS } from '@seti/shared'
import type { SessionSpec } from '../../session-spec.js'
import type { RuntimeShapes, SessionInput } from '../adapter.js'
import { Channel, Run, type RunView } from './run.js'
import type { Script } from './script.js'
import type { ConformanceTarget, NeutralHost, Profile, Rig } from './target.js'

/** The folder every suite session works in; no adapter may touch it, since the runtime is fake. */
const SUITE_CWD = '/work/conformance'

/** A spec with nothing in it but what a case varies; no adapter reads the sandbox stamp. */
function specFor(resume: string | null): SessionSpec {
  return {
    runtime: 'claude',
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
    // The stamp is read only by the setup key, never by an adapter.
    sandbox: {} as SessionSpec['sandbox'],
    account: null,
    vendor: { plugins: [] },
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
}

/** The subject the cases drive for one target. */
export function subjectOf<S extends RuntimeShapes, Id extends string>(target: ConformanceTarget<S, Id>): Subject {
  return {
    id: target.adapter.id,
    profile: target.profile,
    rig: target.rig,
    open: async (rig, options = {}) => {
      const controller = new AbortController()
      const host = target.host(options.host ?? ALLOW_ALL)
      const realised = await target.adapter.realise(specFor(options.resume ?? null), rig.launcher, host, controller)
      const inputs = new Channel<SessionInput>()
      const session = await target.adapter.open(realised, inputs)
      return new Run(session, target.project, inputs, controller).start()
    },
  }
}
