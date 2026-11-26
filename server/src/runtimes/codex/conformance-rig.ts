import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Launcher } from '../../launcher.js'
import { FakeProcess, launcherOf } from '../conformance/process.js'
import { RealProcess, type LineTap, type Outbound } from '../conformance/real-process.js'
import type { Script, ScriptCall, Step } from '../conformance/script.js'
import { SUITE_CWD } from '../conformance/subject.js'
import type { Rig, SpawnRecord } from '../conformance/target.js'
import type { ModelCall, ScriptedResponses } from './conformance-responses.js'
import { serveRigTools } from './conformance-tools.js'

/** What the sandbox hands Codex when a script names no launcher: a path and the key's placeholder. */
const SANDBOX_ENV = { PATH: '/usr/bin:/bin', HOME: '/sandbox/home', OPENAI_API_KEY: 'egress-placeholder' }

/** Steps Codex writes itself rather than the model: the rig adds them to its output. */
type WireStep = Extract<Step, { malformed: true } | { unknown: string } | { garbage: string } | { exit: number }>

const isWire = (step: Step): step is WireStep =>
  'malformed' in step || 'unknown' in step || 'garbage' in step || 'exit' in step

/** A wire step and where it goes: after the agent's text in its turn, or after the turn's start. */
interface Injection {
  turn: number
  after: string | null
  step: WireStep
}

/** The shell command Codex runs for a script call, or null for a call that is no command. */
function commandOf(call: ScriptCall): string | null {
  const { args } = call
  const text = (key: string): string => {
    const value = args[key]
    return typeof value === 'string' ? value : JSON.stringify(value ?? '')
  }
  switch (call.tool) {
    case 'sh':
      return text('cmd')
    case 'cat':
      return `cat ${text('path')}`
    case 'grep':
      return `grep -rn ${text('pattern')} .`
    case 'fetch':
      return `curl -s ${text('url')}`
    default:
      return null
  }
}

/** The patch `apply_patch` takes for a script's edit of one file. */
const patchOf = (args: Record<string, unknown>): string =>
  [
    '*** Begin Patch',
    `*** Update File: ${String(args.path)}`,
    '@@',
    String(args.diff).trimEnd(),
    '*** End Patch',
    '',
  ].join('\n')

/** A script's questions as `request_user_input` takes them: each with an id, header and options. */
function questionsOf(args: Record<string, unknown>): unknown[] {
  const asked = Array.isArray(args.questions) ? (args.questions as { text: string; options: string[] }[]) : []
  return asked.map((one, index) => ({
    id: `q${String(index + 1)}`,
    header: one.text,
    question: one.text,
    options: one.options.map((label) => ({ label, description: label })),
  }))
}

/** The model's call for a script call, by the tools this Codex offers. */
export function codexCall(call: ScriptCall): ModelCall {
  const command = commandOf(call)
  if (command !== null) {
    const background = call.args.background === true ? { yield_time_ms: 250 } : {}
    return { name: 'exec_command', args: { cmd: command, ...background } }
  }
  if (call.tool === 'patch') {
    return { name: 'apply_patch', input: patchOf(call.args) }
  }
  if (call.tool === 'ask') {
    return { name: 'request_user_input', args: { questions: questionsOf(call.args) } }
  }
  const dot = call.tool.indexOf('.')
  if (dot > 0) {
    // Codex names a server's deferred tools by a namespace with every other character as `_`.
    const namespace = `mcp__${call.tool.slice(0, dot).replaceAll(/\W/g, '_')}`
    return { name: call.tool.slice(dot + 1), args: call.args, namespace }
  }
  return { name: call.tool, args: call.args }
}

/** A nested tool's name on the `tools` object of a code mode script. */
const scriptName = (call: Extract<ModelCall, { args: unknown }>): string =>
  (call.namespace === undefined ? call.name : `${call.namespace}__${call.name}`).replaceAll(/\W/g, '_')

/**
 * The model's call for a script call when its model writes code: a command, an edit or a
 * tool server call becomes an `exec` script that calls the nested tool; a question stays direct.
 */
export function codeModeCall(call: ScriptCall): ModelCall {
  const direct = codexCall(call)
  if (
    direct.name === 'request_user_input' ||
    (!('input' in direct) && commandOf(call) === null && !call.tool.includes('.'))
  ) {
    return direct
  }
  const argument = 'input' in direct ? JSON.stringify(direct.input) : JSON.stringify(direct.args)
  return { name: 'exec', input: `text(await tools.${scriptName({ ...direct, args: {} })}(${argument}))` }
}

const ESCAPED_QUOTE = `'\\''`

const quoted = (text: string): string => `'${text.replaceAll("'", ESCAPED_QUOTE)}'`

/**
 * A login shell profile that stands in for every command the script runs: it notes the call and
 * prints the script's output instead of running it. Codex runs `<shell> -lc '<command>'`.
 */
function profileOf(script: Script, effects: string, nextTurn: string): string {
  const calls = script.turns
    .flat()
    .map(asCall)
    .flatMap((step) => ('call' in step ? [step.call] : []))
  const arms = calls.flatMap((call) => {
    const command = commandOf(call)
    if (command === null) {
      return []
    }
    const effect = `${call.tool} ${JSON.stringify(call.args)}`
    const code = call.fails === true ? 'exit 1' : 'exit 0'
    const waits = call.args.background === true ? `while [ ! -e ${quoted(nextTurn)} ]; do sleep 0.05; done; ` : ''
    const ending = call.hold === true ? 'exec sleep 30' : `${waits}${code}`
    const output = `printf '%s' ${quoted(call.output ?? '')}`
    return [`  ${quoted(command)}) printf '%s\\n' ${quoted(effect)} >> ${quoted(effects)}; ${output}; ${ending} ;;`]
  })
  return [
    '__rig_cmd="${ZSH_EXECUTION_STRING-${BASH_EXECUTION_STRING-}}"',
    'case "$__rig_cmd" in',
    ...arms,
    'esac',
    '',
  ].join('\n')
}

/** A background job as the model starts it: a command that outlives its call's wait. */
function asCall(step: Step): Step {
  return 'job' in step ? { call: { tool: 'sh', args: { cmd: step.job, background: true }, output: step.job } } : step
}

/** Where each wire step of the script goes in Codex's output. */
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

/** The line Codex would write for a wire step, or the exit it makes. */
function wireLine(step: WireStep): Outbound {
  if ('exit' in step) {
    return { lines: [], exit: step.exit }
  }
  if ('garbage' in step) {
    return { lines: [step.garbage] }
  }
  if ('unknown' in step) {
    return { lines: [JSON.stringify({ method: step.unknown, params: {} })] }
  }
  const broken = { type: 'agentMessage', id: 'broken', text: 42 }
  return { lines: [JSON.stringify({ method: 'item/completed', params: { item: broken } })] }
}

/** The method of a line Codex wrote and, for an agent message, its text. */
function lineOf(line: string): { method: string; said: string | null } {
  try {
    const parsed = JSON.parse(line) as { method?: unknown; params?: { item?: { type?: unknown; text?: unknown } } }
    const item = parsed.params?.item
    const said = parsed.method === 'item/completed' && item?.type === 'agentMessage' ? String(item.text) : null
    return { method: typeof parsed.method === 'string' ? parsed.method : '', said }
  } catch {
    return { method: '', said: null }
  }
}

/** The rig's place between Seti and Codex: paths as the sandbox mounts them, wire steps added. */
class Tap implements LineTap {
  private turn = -1
  private held: string[] = []
  private readonly pending: Injection[]
  private readonly work: string
  private readonly refuseInterrupt: boolean

  private readonly model: ScriptedResponses
  private readonly nextTurn: string
  private starts = 0

  constructor(script: Script, at: { work: string; nextTurn: string }, model: ScriptedResponses) {
    this.model = model
    this.nextTurn = at.nextTurn
    this.pending = injectionsOf(script)
    this.work = at.work
    this.refuseInterrupt = script.refuseInterrupt === true
  }

  inbound(line: string, answer: (line: string) => void): string[] {
    const sent = JSON.parse(line) as { id?: unknown; method?: unknown }
    if (sent.method === 'turn/steer') {
      this.model.steered()
    }
    if (sent.method === 'turn/start') {
      this.starts += 1
      if (this.starts > 1) {
        writeFileSync(this.nextTurn, '')
      }
    }
    if (this.refuseInterrupt && sent.method === 'turn/interrupt') {
      answer(JSON.stringify({ id: sent.id, error: { code: -32603, message: 'the turn cannot be interrupted' } }))
      return []
    }
    return [line.replaceAll(SUITE_CWD, this.work)]
  }

  outbound(raw: string): Outbound {
    const line = raw.replaceAll(this.work, SUITE_CWD)
    const { method, said } = lineOf(line)
    const held = this.held
    this.held = []
    if (method === 'item/started') {
      // Codex writes a call's ask right after its start; they reach Seti together, as in one read.
      this.held = [line]
      return { lines: held }
    }
    this.turn += method === 'turn/started' ? 1 : 0
    const out: Outbound = { lines: [...held, line] }
    if (method !== 'turn/started' && said === null) {
      return out
    }
    const anchor = method === 'turn/started' ? null : said
    for (let next = this.pending[0]; next?.turn === this.turn && next.after === anchor; next = this.pending[0]) {
      const wire = wireLine(next.step)
      this.pending.shift()
      out.lines.push(...wire.lines)
      if (wire.exit !== undefined) {
        return { lines: out.lines, exit: wire.exit }
      }
    }
    return out
  }
}

/** The script with the steps only Codex's output carries left out, as the scripted model plays it. */
const modelTurns = (script: Script): Step[][] =>
  script.turns.map((steps) => steps.filter((step) => !isWire(step)).map(asCall))

/** A file a script edits, as it starts, and the effect its edit notes once the file changed. */
interface Edit {
  file: string
  before: string
  effect: string
}

/** The files the script's edits change, made in the work folder with the lines the diffs remove. */
function edits(script: Script, work: string): Edit[] {
  const patches = script.turns
    .flat()
    .flatMap((step) => ('call' in step && step.call.tool === 'patch' ? [step.call] : []))
  return patches.map((call) => {
    const file = path.join(work, String(call.args.path))
    const removed = String(call.args.diff)
      .split('\n')
      .flatMap((line) => (line.startsWith('-') ? [line.slice(1)] : []))
    const before = removed.map((line) => `${line}\n`).join('')
    writeFileSync(file, before)
    return { file, before, effect: `${call.tool} ${JSON.stringify(call.args)}` }
  })
}

/**
 * The effects so far, read again on every access like the list a fake runtime keeps: commands
 * the profile noted, then edits whose file changed.
 */
function liveEffects(log: string, changes: readonly Edit[]): readonly string[] {
  const seen: string[] = []
  const sync = (): void => {
    const ran = readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
    const edited = changes.filter((edit) => readFileSync(edit.file, 'utf8') !== edit.before).map((edit) => edit.effect)
    seen.splice(0, seen.length, ...ran, ...edited)
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

/** Where rigs run: the scripted model, the folder for their homes, and every process they start. */
export interface RigBench {
  model: ScriptedResponses
  folder: string
  started: RealProcess[]
}

/** A rig for the real `codex` the adapter starts: a scripted model, a profile for commands. */
export function codexRig(bench: RigBench, script: Script): Rig {
  const { model } = bench
  rigs += 1
  const root = mkdtempSync(path.join(bench.folder, `rig-${String(rigs)}-`))
  const home = path.join(root, 'home')
  const work = path.join(root, 'work')
  mkdirSync(home)
  mkdirSync(work)
  const effects = path.join(root, 'effects.log')
  writeFileSync(effects, '')
  const nextTurn = path.join(root, 'next-turn')
  const profile = profileOf(script, effects, nextTurn)
  for (const name of ['.zshenv', '.bash_profile', '.bash_env']) {
    writeFileSync(path.join(home, name), profile)
  }
  model.play(modelTurns(script))
  const spawns: SpawnRecord[] = []
  const started: RealProcess[] = []
  const start: NonNullable<Launcher['spawn']> = (request) => {
    spawns.push({ command: request.command, args: request.args, cwd: request.cwd, env: request.env })
    if (script.exitAtStart !== undefined) {
      const dead = new FakeProcess(request.signal)
      dead.finish(script.exitAtStart, null)
      return dead
    }
    const env = { ...request.env, HOME: home, PATH: process.env.PATH, BASH_ENV: path.join(home, '.bash_env') }
    const real = new RealProcess(
      {
        command: request.command,
        args: request.args,
        cwd: work,
        env,
        tap: new Tap(script, { work, nextTurn }, model),
        deaf: script.deaf === true,
      },
      request.signal,
    )
    started.push(real)
    bench.started.push(real)
    return real
  }
  const launcherEnv = script.launcher?.env ?? SANDBOX_ENV
  const launcher = launcherOf({ ...script, launcher: { ...script.launcher, env: launcherEnv } }, start)
  serveRigTools(launcher, script, { root, effects })
  return {
    launcher,
    spawns,
    selfStarts: [],
    effects: liveEffects(effects, edits(script, work)),
    crash: (code) => {
      started.at(-1)?.crash(code)
    },
  }
}
