import { createInterface } from 'node:readline'
import type { Launcher } from '../../launcher.js'
import { FakeProcess } from '../conformance/process.js'
import type { Script } from '../conformance/script.js'
import type { Rig, SpawnRecord } from '../conformance/target.js'
import type { ScriptedCommand } from './dialect.js'
import { ScriptedRuntime, type MachineState } from './runtime.js'

/** Connects a new scripted runtime to the process's pipes. */
function boot(child: FakeProcess, state: MachineState): void {
  const { stdout } = child
  const runtime = new ScriptedRuntime(state, {
    write: (line) => {
      stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`)
    },
    fail: (text, code) => {
      child.stderr.push(`${text}\n`)
      child.finish(code, null)
    },
  })
  const lines = createInterface({ input: child.stdin })
  lines.on('line', (line) => {
    runtime.receive(JSON.parse(line) as ScriptedCommand)
  })
}

/**
 * A host where the scripted runtime plays the script. Its launcher starts the runtime the way
 * Seti's sandbox launcher starts a real one; saved sessions survive from one process to the next.
 */
export function scriptedMachine(script: Script, env: Record<string, string> = {}): Rig {
  const state: MachineState = { script, sessions: new Map(), effects: [], turns: 0 }
  const spawns: SpawnRecord[] = []
  const spawn: NonNullable<Launcher['spawn']> = (request) => {
    spawns.push({ command: request.command, args: request.args, cwd: request.cwd, env: request.env })
    const child = new FakeProcess(request.signal)
    boot(child, state)
    return child
  }
  return { launcher: { sandboxed: true, env, spawn }, spawns, effects: state.effects }
}
