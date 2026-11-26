import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Launcher } from '../../launcher.js'
import { FakeProcess, launcherOf } from '../conformance/process.js'
import { RealProcess, type LineTap, type Outbound } from '../conformance/real-process.js'
import type { Script, ScriptCall, Step } from '../conformance/script.js'
import { SUITE_CWD } from '../conformance/subject.js'
import type { Rig, SpawnRecord } from '../conformance/target.js'
import type { ModelCall, ScriptedGemini } from './conformance-api.js'

/** What the sandbox hands Gemini CLI when a script names no launcher: paths, key and proxy. */
const SANDBOX_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/sandbox/home',
  GEMINI_API_KEY: 'egress-placeholder',
  HTTPS_PROXY: 'http://127.0.0.1:9',
}

/** Only the scripted API on loopback is reached directly; anything else meets a closed port. */
const NO_PROXY = { NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: 'http://127.0.0.1:9' }

/** Steps Gemini CLI writes itself rather than the model: the rig adds them to its output. */
type WireStep = Extract<Step, { malformed: true } | { unknown: string } | { garbage: string } | { exit: number }>

const isWire = (step: Step): step is WireStep =>
  'malformed' in step || 'unknown' in step || 'garbage' in step || 'exit' in step

/** The lines removed and added by a script's diff, as an edit's old and new text. */
function sidesOf(diff: string): { before: string; after: string } {
  const lines = diff.split('\n')
  const side = (mark: string) =>
    lines
      .filter((line) => line.startsWith(mark))
      .map((line) => `${line.slice(1)}\n`)
      .join('')
  return { before: side('-'), after: side('+') }
}

/** A background job as the model starts it: a command that outlives its call's wait. */
const asCall = (step: Step): Step =>
  'job' in step ? { call: { tool: 'sh', args: { cmd: step.job, background: true }, output: step.job } } : step

/** The model's function call for a script call, by the tools Gemini CLI offers. */
export function geminiCall(call: ScriptCall): ModelCall {
  const { args } = call
  const text = (key: string): string => {
    const value = args[key]
    return typeof value === 'string' ? value : JSON.stringify(value ?? '')
  }
  switch (call.tool) {
    case 'sh':
      return { name: 'run_shell_command', args: { command: text('cmd'), is_background: args.background === true } }
    case 'cat':
      return { name: 'read_file', args: { file_path: text('path') } }
    case 'grep':
      return { name: 'grep_search', args: { pattern: text('pattern') } }
    case 'fetch':
      return { name: 'web_fetch', args: { prompt: `Summarise ${text('url')}` } }
    case 'patch': {
      const { before, after } = sidesOf(text('diff'))
      if (before === '') {
        return { name: 'write_file', args: { file_path: text('path'), content: after } }
      }
      const instruction = 'Apply the edit'
      return { name: 'replace', args: { file_path: text('path'), instruction, old_string: before, new_string: after } }
    }
    default:
      return { name: call.tool.replaceAll('.', '__'), args }
  }
}

const ESCAPED_QUOTE = `'\\''`

const quoted = (text: string): string => `'${text.replaceAll("'", ESCAPED_QUOTE)}'`

/**
 * A shell profile that stands in for every command the script runs: it notes the call and prints
 * the script's output instead. Gemini CLI wraps a command in a subshell, one line of its own.
 */
function profileOf(calls: readonly ScriptCall[], effects: string, nextTurn: string): string {
  const arms = calls.flatMap((call) => {
    if (call.tool !== 'sh') {
      return []
    }
    const effect = `${call.tool} ${JSON.stringify(call.args)}`
    const waits = call.args.background === true ? `while [ ! -e ${quoted(nextTurn)} ]; do sleep 0.05; done; ` : ''
    const code = call.fails === true ? 'exit 1' : 'exit 0'
    const ending = call.hold === true ? 'exec sleep 30' : `${waits}${code}`
    const output = `printf '%s' ${quoted(call.output ?? '')}`
    const command = typeof call.args.cmd === 'string' ? call.args.cmd : ''
    return [
      `if __rig_ran ${quoted(command)}; then printf '%s\\n' ${quoted(effect)} >> ${quoted(effects)}; ${output}; ${ending}; fi`,
    ]
  })
  return [
    `__rig_ran() { case $'\\n'"\${BASH_EXECUTION_STRING-}"$'\\n' in *$'\\n'"$1"$'\\n'*) return 0 ;; esac; return 1; }`,
    ...arms,
    '',
  ].join('\n')
}

/** A wire step and where it goes: after the agent's text in its turn, or at the turn's start. */
interface Injection {
  turn: number
  after: string | null
  step: WireStep
}

function injectionsOf(script: Script): Injection[] {
  return script.turns.flatMap((steps, turn) => {
    let after: string | null = null
    return steps.flatMap((step) => {
      if ('say' in step) {
        after = step.say
      }
      return isWire(step) ? [{ turn, after, step }] : []
    })
  })
}

/** The session and, for a message chunk, the text of a line Gemini CLI wrote. */
function lineOf(line: string): { session: string | null; said: string | null } {
  try {
    const parsed = JSON.parse(line) as { params?: { sessionId?: unknown; update?: Record<string, unknown> } }
    const update = parsed.params?.update
    const content = update?.content as { text?: unknown } | undefined
    const said = update?.sessionUpdate === 'agent_message_chunk' ? String(content?.text) : null
    const session = parsed.params?.sessionId
    return { session: typeof session === 'string' ? session : null, said }
  } catch {
    return { session: null, said: null }
  }
}

/** The rig between Seti and Gemini CLI: paths as the sandbox mounts them, wire steps added. */
class Tap implements LineTap {
  private turn = -1
  private session = ''
  private fresh = false
  private readonly pending: Injection[]
  private readonly work: string
  private readonly nextTurn: string

  constructor(script: Script, at: { work: string; nextTurn: string }) {
    this.pending = injectionsOf(script)
    this.work = at.work
    this.nextTurn = at.nextTurn
  }

  inbound(line: string): string[] {
    const sent = JSON.parse(line) as { method?: unknown }
    if (sent.method === 'session/prompt') {
      this.turn += 1
      this.fresh = true
      if (this.turn > 0) {
        writeFileSync(this.nextTurn, '')
      }
    }
    return [line.replaceAll(SUITE_CWD, this.work)]
  }

  outbound(raw: string): Outbound {
    const line = raw.replaceAll(this.work, SUITE_CWD)
    const { session, said } = lineOf(line)
    this.session = session ?? this.session
    const first = this.fresh && session !== null ? this.inject(null) : { lines: [] }
    this.fresh = this.fresh && session === null
    if (first.exit !== undefined) {
      return first
    }
    const after = said === null ? { lines: [] } : this.inject(said)
    return { lines: [...first.lines, line, ...after.lines], ...(after.exit === undefined ? {} : { exit: after.exit }) }
  }

  /** The wire steps anchored here, up to the first that ends the process. */
  private inject(anchor: string | null): Outbound {
    const lines: string[] = []
    for (let next = this.pending[0]; next?.turn === this.turn && next.after === anchor; next = this.pending[0]) {
      this.pending.shift()
      const wire = this.wireLine(next.step)
      lines.push(...wire.lines)
      if (wire.exit !== undefined) {
        return { lines, exit: wire.exit }
      }
    }
    return { lines }
  }

  private wireLine(step: WireStep): Outbound {
    if ('exit' in step) {
      return { lines: [], exit: step.exit }
    }
    if ('garbage' in step) {
      return { lines: [step.garbage] }
    }
    const update = 'unknown' in step ? { sessionUpdate: step.unknown } : { sessionUpdate: 'tool_call', toolCallId: 42 }
    const note = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: this.session, update } }
    return { lines: [JSON.stringify(note)] }
  }
}

/** A file a script edits, as it starts, and the effect its edit notes once the file changed. */
interface Edit {
  file: string
  before: string
  effect: string
}

const effectOf = (call: ScriptCall) => `${call.tool} ${JSON.stringify(call.args)}`

/** The calls Gemini CLI runs itself, not as a command: an answer without an error means it ran. */
function answeredEffects(calls: readonly ScriptCall[], responses: readonly string[]): string[] {
  const left = calls.filter((call) => call.tool !== 'sh' && call.tool !== 'patch')
  return responses.flatMap((response) => {
    const at = left.findIndex((call) => response.startsWith(`${geminiCall(call).name} `))
    const call = left[at]
    if (call === undefined || response.includes('"error"')) {
      return []
    }
    left.splice(at, 1)
    return [effectOf(call)]
  })
}

/** The effects so far, read again on every access like the list a fake runtime keeps. */
function liveEffects(read: () => string[]): readonly string[] {
  const seen: string[] = []
  const sync = (): void => {
    seen.splice(0, seen.length, ...read())
  }
  return new Proxy(seen, {
    get: (target, key, receiver) => {
      sync()
      return Reflect.get(target, key, receiver) as unknown
    },
    has: (target, key) => {
      sync()
      return Reflect.has(target, key)
    },
    ownKeys: (target) => {
      sync()
      return Reflect.ownKeys(target)
    },
    getOwnPropertyDescriptor: (target, key) => {
      sync()
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
}

let rigs = 0

/** Where rigs run: the scripted API, the folder for their homes, and every process they start. */
export interface RigBench {
  model: ScriptedGemini
  folder: string
  started: RealProcess[]
}

/** A rig for the real Gemini CLI the adapter starts: a scripted API, a profile for commands. */
export function geminiRig(bench: RigBench, script: Script): Rig {
  rigs += 1
  const root = mkdtempSync(path.join(bench.folder, `rig-${String(rigs)}-`))
  const [home, work] = [path.join(root, 'home'), path.join(root, 'work')]
  mkdirSync(home)
  mkdirSync(work)
  const effects = path.join(root, 'effects.log')
  writeFileSync(effects, '')
  const nextTurn = path.join(root, 'next-turn')
  const calls = script.turns
    .flat()
    .map(asCall)
    .flatMap((step) => ('call' in step ? [step.call] : []))
  writeFileSync(path.join(home, '.bash_env'), profileOf(calls, effects, nextTurn))
  const edits: Edit[] = calls
    .filter((call) => call.tool === 'patch')
    .map((call) => {
      const file = path.join(work, String(call.args.path))
      const { before } = sidesOf(String(call.args.diff))
      writeFileSync(file, before)
      return { file, before, effect: effectOf(call) }
    })
  for (const call of calls.filter(
    (each) => each.tool === 'cat' && !edits.some((edit) => edit.effect === effectOf(each)),
  )) {
    writeFileSync(path.join(work, String(call.args.path)), call.output ?? '')
  }
  bench.model.play(script.turns.map((steps) => steps.filter((step) => !isWire(step)).map(asCall)))
  const spawns: SpawnRecord[] = []
  const started: RealProcess[] = []
  const start: NonNullable<Launcher['spawn']> = (request) => {
    spawns.push({ command: request.command, args: request.args, cwd: request.cwd, env: request.env })
    if (script.exitAtStart !== undefined) {
      const dead = new FakeProcess(request.signal)
      dead.finish(script.exitAtStart, null)
      return dead
    }
    const env = {
      ...request.env,
      ...NO_PROXY,
      HOME: home,
      PATH: process.env.PATH,
      BASH_ENV: path.join(home, '.bash_env'),
    }
    const tap = new Tap(script, { work, nextTurn })
    const real = new RealProcess(
      { command: request.command, args: request.args, cwd: work, env, tap, deaf: script.deaf === true },
      request.signal,
    )
    started.push(real)
    bench.started.push(real)
    return real
  }
  const launcher = launcherOf(
    { ...script, launcher: { ...script.launcher, env: script.launcher?.env ?? SANDBOX_ENV } },
    start,
  )
  const read = () => [
    ...readFileSync(effects, 'utf8')
      .split('\n')
      .filter((line) => line !== ''),
    ...answeredEffects(calls, bench.model.responses),
    ...edits.filter((edit) => readFileSync(edit.file, 'utf8') !== edit.before).map((edit) => edit.effect),
  ]
  return {
    launcher,
    spawns,
    selfStarts: [],
    effects: liveEffects(read),
    crash: (code) => {
      started.at(-1)?.crash(code)
    },
  }
}
