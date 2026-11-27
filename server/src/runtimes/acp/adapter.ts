import { projectAcp } from '@seti/shared'
import type { Launcher } from '../../launcher.js'
import type { Capabilities, RuntimeAdapter } from '../adapter.js'
import { oneInput, type OneShot } from '../one-shot.js'
import type { AcpDecide } from './permissions.js'
import { acpSession, type AcpRealised, type AcpShapes } from './session.js'

/**
 * What an ACP runtime's profile adds to a session: the agent's name, the program and its
 * arguments for a model, the environment Seti presets over the sandbox's, and the variable that
 * must hold the model key's placeholder.
 */
interface AcpLaunch {
  label: string
  command: string
  args: (model: string) => string[]
  env: Record<string, string>
  keyVariable: string
  /** The model a session runs when its spec names none. */
  model: string
}

/** The launcher's spawn, once it is sandboxed and its environment holds the key's placeholder. */
function sandboxedSpawn(launch: AcpLaunch, launcher: Launcher) {
  if (!launcher.sandboxed || launcher.spawn === undefined) {
    throw new Error(`${launch.label} runs only in Seti's sandbox, started through its launcher`)
  }
  if (launcher.env[launch.keyVariable] === undefined) {
    throw new Error(`This ${launch.label} agent has no model key: its credential needs the key's connection`)
  }
  return launcher.spawn
}

interface Session {
  cwd: string
  resume: string | null
  model: string
  decide: AcpDecide
  signal: AbortSignal
}

/** What starts one agent process, with the profile's presets over the sandbox's environment. */
function realiseAcp(launch: AcpLaunch, launcher: Launcher, session: Session): AcpRealised {
  const spawn = sandboxedSpawn(launch, launcher)
  return {
    label: launch.label,
    command: launch.command,
    args: launch.args(session.model),
    env: { ...launcher.env, ...launch.env },
    mcpServers: [],
    spawn,
    ...session,
  }
}

const REFUSAL = 'This call offers no tools; answer from what you were given.'

/** A one-shot: a new session with no tool server whose every ask Seti refuses at once. */
const acpOneShot = (launch: AcpLaunch): OneShot => ({
  open: async (request, launcher, abortController) => {
    const realised = realiseAcp(launch, launcher, {
      cwd: request.cwd,
      resume: null,
      model: request.model,
      decide: async () => Promise.resolve({ allow: false, message: REFUSAL }),
      signal: abortController.signal,
    })
    return Promise.resolve(acpSession(realised, oneInput(`${request.system}\n\n${request.prompt}`)))
  },
})

/**
 * What an ACP agent can do as Seti drives it: no rewrite of a call's input, no fork, rewind,
 * plugins, Bypass or classifier, and only Seti's tools through its relay.
 */
const capabilitiesOf = (launch: AcpLaunch): Capabilities => ({
  gate: { rewriteInput: false, classifier: false },
  session: { fork: 'none' },
  rewind: { conversation: false, code: false },
  tools: { userServers: [], serverNames: null, plugins: false },
  sandbox: { optional: false },
  compaction: null,
  subagents: false,
  bypass: false,
  slashCommands: false,
  dream: null,
  oneShot: acpOneShot(launch),
})

/** An ACP agent run as one process per session, in Seti's sandbox only. */
export const acpAdapterFor = <Id extends string>(id: Id, launch: AcpLaunch): RuntimeAdapter<AcpShapes, Id> => ({
  id,
  capabilities: capabilitiesOf(launch),
  project: projectAcp,
  realise: async (spec, launcher, host, abortController) =>
    Promise.resolve(
      realiseAcp(launch, launcher, {
        cwd: spec.cwd,
        resume: spec.resume,
        model: launch.model,
        decide: host.decide,
        signal: abortController.signal,
      }),
    ),
  open: async (realised, input) => Promise.resolve(acpSession(realised, input)),
})
