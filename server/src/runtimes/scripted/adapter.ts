import type { RuntimeAdapter } from '../adapter.js'
import { projectScripted } from './project.js'
import { scriptedSession, type ScriptedShapes } from './session.js'

/** The scripted runtime's program; only a scripted machine's launcher knows how to start it. */
const COMMAND = 'seti-scripted-runtime'

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
    tools: { userServers: [], serverNames: null, plugins: false },
    sandbox: { optional: true },
    compaction: false,
    subagents: true,
    dream: null,
  },
  project: projectScripted,
  realise: async (spec, launcher, host, abortController) => {
    if (launcher.spawn === undefined) {
      throw new Error('The scripted runtime starts only through a launcher that spawns it')
    }
    return Promise.resolve({
      command: COMMAND,
      args: ['--stdio'],
      cwd: spec.cwd,
      env: { ...launcher.env, SCRIPTED_TASK: spec.taskId },
      resume: spec.resume,
      spawn: launcher.spawn,
      decide: host.decide,
      signal: abortController.signal,
    })
  },
  open: async (realised, input) => Promise.resolve(scriptedSession(realised, input)),
}
