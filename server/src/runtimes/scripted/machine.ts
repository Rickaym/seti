import { createInterface } from 'node:readline'
import type { Launcher } from '../../launcher.js'
import { FakeProcess, launcherOf } from '../conformance/process.js'
import type { Script } from '../conformance/script.js'
import type { Rig, SpawnRecord } from '../conformance/target.js'
import type { ScriptedCommand } from './dialect.js'
import { ScriptedRuntime, type MachineState } from './runtime.js'

/** Ends the process with the text on its stderr, as a runtime that fails does. */
const fail = (child: FakeProcess, text: string, code: number) => {
  child.stderr.push(`${text}\n`)
  child.finish(code, null)
}

/** Connects a new scripted runtime to the process's pipes; nothing it writes after its exit lands. */
function boot(child: FakeProcess, state: MachineState): void {
  if (state.script.exitAtStart !== undefined) {
    fail(child, 'scripted runtime failed to start', state.script.exitAtStart)
    return
  }
  const { stdout } = child
  const runtime = new ScriptedRuntime(state, {
    write: (line) => {
      if (!child.ended) {
        stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`)
      }
    },
    fail: (text, code) => {
      fail(child, text, code)
    },
  })
  const lines = createInterface({ input: child.stdin })
  lines.on('line', (line) => {
    if (!child.ended) {
      runtime.receive(JSON.parse(line) as ScriptedCommand)
    }
  })
}

/**
 * A host where the scripted runtime plays the script. Its launcher starts the runtime the way
 * Seti's sandbox launcher starts a real one; saved sessions survive from one process to the next.
 */
export function scriptedMachine(script: Script): Rig {
  const state: MachineState = { script, sessions: new Map(), effects: [], turns: 0 }
  const spawns: SpawnRecord[] = []
  let newest: FakeProcess | null = null
  const start: NonNullable<Launcher['spawn']> = (request) => {
    spawns.push({ command: request.command, args: request.args, cwd: request.cwd, env: request.env })
    const child = new FakeProcess(request.signal, script.deaf === true)
    newest = child
    boot(child, state)
    return child
  }
  return {
    launcher: launcherOf(script, start),
    spawns,
    selfStarts: [],
    effects: state.effects,
    crash: (code) => {
      if (newest !== null) {
        fail(newest, 'killed', code)
      }
    },
  }
}
