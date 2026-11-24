import { appendFileSync } from 'node:fs'
import path from 'node:path'
import type { Launcher } from '../../launcher.js'
import type { RelayedServer, RelayPlace } from '../../tool-relay.js'
import type { Script, ScriptCall, Step } from '../conformance/script.js'

/** The tool servers a rig serves Codex through Seti's relay, and where their sockets go. */
interface RigTools {
  place: RelayPlace
  servers: RelayedServer[]
}

/** Each rig's tool servers, by the launcher its sessions start through. */
const byLauncher = new WeakMap<Launcher, RigTools>()

export const rigTools = (launcher: Launcher): RigTools | undefined => byLauncher.get(launcher)

const SHELL_TOOLS = new Set(['sh', 'cat', 'grep', 'fetch', 'patch', 'ask'])

/** A script's calls of tool server tools (`server.tool`), with the steps a subagent plays. */
function serverCalls(steps: readonly Step[]): ScriptCall[] {
  return steps.flatMap((step) => {
    if ('subagent' in step) {
      return serverCalls(step.subagent.steps)
    }
    return 'call' in step && !SHELL_TOOLS.has(step.call.tool) && step.call.tool.indexOf('.') > 0 ? [step.call] : []
  })
}

/** Waits until the call is cancelled, as a held call runs until the turn is interrupted. */
const cancelled = async (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => {
      resolve()
    })
  })

/** One server of the script: its tools answer the script's output and note the effect. */
function serverOf(name: string, calls: ScriptCall[], effects: string): RelayedServer {
  const tools = [...new Set(calls.map((call) => call.tool.slice(name.length + 1)))]
  return {
    name,
    tools: tools.map((tool) => ({ name: tool, description: `The script's ${tool}`, inputSchema: { type: 'object' } })),
    call: async (tool, args, signal) => {
      const call = calls.find((each) => each.tool === `${name}.${tool}`)
      appendFileSync(effects, `${name}.${tool} ${JSON.stringify(args)}\n`)
      if (call?.hold === true) {
        await cancelled(signal)
      }
      return { content: [{ type: 'text', text: call?.output ?? '' }], isError: call?.fails === true }
    },
  }
}

/** Serves the script's tool servers to sessions that start through this launcher. */
export function serveRigTools(launcher: Launcher, script: Script, at: { root: string; effects: string }): void {
  const calls = serverCalls(script.turns.flat())
  const names = [...new Set(calls.map((call) => call.tool.slice(0, call.tool.indexOf('.'))))]
  const servers = names.map((name) =>
    serverOf(
      name,
      calls.filter((call) => call.tool.startsWith(`${name}.`)),
      at.effects,
    ),
  )
  const dir = path.join(at.root, 'run')
  byLauncher.set(launcher, { place: { dir, seenAs: dir }, servers })
}
