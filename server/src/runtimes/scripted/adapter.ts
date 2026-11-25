import type { Launcher } from '../../launcher.js'
import type { RuntimeAdapter } from '../adapter.js'
import { oneInput } from '../one-shot.js'
import type { Verdict } from './dialect.js'
import { projectScripted } from './project.js'
import { scriptedSession, type ScriptedShapes } from './session.js'

/** The scripted runtime's program; only a scripted machine's launcher knows how to start it. */
const COMMAND = 'seti-scripted-runtime'

/** Where a scripted process starts, for a session of the task or a one-shot. */
function launch(launcher: Launcher, at: { cwd: string; taskId: string; resume: string | null }) {
  if (launcher.spawn === undefined) {
    throw new Error('The scripted runtime starts only through a launcher that spawns it')
  }
  return {
    command: COMMAND,
    args: ['--stdio'],
    cwd: at.cwd,
    env: { ...launcher.env, SCRIPTED_TASK: at.taskId },
    resume: at.resume,
    spawn: launcher.spawn,
  }
}

const refuse = async (): Promise<Verdict> => Promise.resolve({ allow: false, message: 'This call offers no tools.' })

/**
 * A test-only adapter for the scripted runtime, a stand-in that plays a script over stdio. It is
 * the second adapter that keeps the interface honest and is never in the registry.
 */
export const scriptedAdapter: RuntimeAdapter<ScriptedShapes, 'scripted'> = {
  id: 'scripted',
  capabilities: {
    gate: { rewriteInput: true, classifier: false },
    session: { fork: 'none' },
    rewind: { conversation: false, code: false },
    tools: { userServers: false, plugins: false },
    sandbox: { optional: true },
    compaction: false,
    dream: null,
    oneShot: {
      open: async (request, launcher, abortController) => {
        const at = { cwd: request.cwd, taskId: 'one-shot', resume: null }
        const realised = { ...launch(launcher, at), decide: refuse, signal: abortController.signal }
        return Promise.resolve(scriptedSession(realised, oneInput(request.prompt)))
      },
    },
  },
  project: projectScripted,
  realise: async (spec, launcher, host, abortController) =>
    Promise.resolve({
      ...launch(launcher, { cwd: spec.cwd, taskId: spec.taskId, resume: spec.resume }),
      decide: host.decide,
      signal: abortController.signal,
    }),
  open: async (realised, input) => Promise.resolve(scriptedSession(realised, input)),
}
