import type { ConformanceTarget } from '../conformance/target.js'
import { scriptedAdapter } from './adapter.js'
import type { Verdict } from './dialect.js'
import { scriptedMachine } from './machine.js'
import { projectScripted } from './project.js'
import type { ScriptedShapes } from './session.js'

/** The scripted adapter as the suite drives it; it declares everything the suite reads. */
export const scriptedTarget: ConformanceTarget<ScriptedShapes, 'scripted'> = {
  adapter: scriptedAdapter,
  profile: {
    events: { turnStart: true, reasoning: true },
    usage: { tokens: true, costUsd: 'reported' },
    input: { steer: 'next_step', retract: true },
    background: { jobs: true, stop: true },
    gated: { shell: true, edit: true, mcp: true },
  },
  project: projectScripted,
  host: (neutral) => ({
    decide: async (call, signal): Promise<Verdict> => {
      if (call.kind === 'question') {
        const answers = await neutral.ask(call.question?.questions ?? [], signal)
        return { allow: true, args: { ...(call.input as Record<string, unknown>), answers } }
      }
      const decision = await neutral.decide(call, signal)
      if (!decision.allow) {
        return decision
      }
      return decision.input === undefined ? { allow: true } : { allow: true, args: decision.input }
    },
    hooks: null,
    toolServers: {},
  }),
  rig: (script) => scriptedMachine(script),
}
