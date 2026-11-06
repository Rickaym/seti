import { writeSync } from 'node:fs'
import { registerHooks } from 'node:module'
import type { ModEngineLimits, ModEvent, ModEventContext } from '@seti/shared'
import type { RunnerConfig } from './engine-files.js'
import type { ModuleOutcome } from '../../quickjs/engine.js'

/** The parent's messages as this child reads them; the parent validated them before sending. */
type Incoming =
  | { type: 'event'; eventId: string; script: string; event: ModEvent; ctx: ModEventContext; limits: ModEngineLimits }
  | { type: 'reply'; callId: number; ok: boolean; value?: unknown; error?: unknown }

const exit: (code: number) => never = process.exit.bind(process)
const stdin = process.stdin
const config = JSON.parse(process.argv[2] ?? '{}') as RunnerConfig
const BUILTINS = new Set(['fs', 'path', 'url', 'module'])

function die(reason: string): never {
  writeSync(2, `mod runner: ${reason}\n`)
  exit(1)
}

const send = (message: object) => {
  writeSync(1, `${JSON.stringify(message)}\n`)
}

const packageOf = (specifier: string) => {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '')
}

/** Only the engine's own packages and the few builtins its loader uses can be imported. */
registerHooks({
  resolve(specifier, context, nextResolve) {
    const mapped = Object.hasOwn(config.modules, specifier) ? config.modules[specifier] : undefined
    if (mapped !== undefined) {
      return { url: mapped, shortCircuit: true }
    }
    if (BUILTINS.has(specifier.replace(/^node:/, ''))) {
      return nextResolve(specifier, context)
    }
    const parent = context.parentURL ?? ''
    if (/^\.\.?\//.test(specifier) && parent.startsWith('file:')) {
      const source = parent.endsWith('.ts') ? specifier.replace(/\.js$/, '.ts') : specifier
      return nextResolve(source, context)
    }
    const own = packageOf(specifier)
    if (Object.hasOwn(config.modules, own) && parent.includes(`/node_modules/${own}/`)) {
      return nextResolve(specifier, context)
    }
    throw new Error(`The mod runner cannot import ${specifier}`)
  },
})

const engine = await import('../../quickjs/engine.js')
const { LOGIC_ENTRY } = await import('./prelude.js')
await engine.loadEngine()

/** Takes away what reaches past this process: network globals, the environment and signals. */
function lockDown(): void {
  for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'navigator']) {
    Reflect.deleteProperty(globalThis, name)
  }
  const shim = Object.freeze({
    env: Object.freeze({}),
    argv: Object.freeze([]),
    platform: process.platform,
    version: process.version,
    versions: process.versions,
  })
  Object.defineProperty(globalThis, 'process', { value: shim, writable: false, configurable: false })
}

let busy = false
const pending = new Map<number, (reply: Extract<Incoming, { type: 'reply' }>) => void>()

const envelope = (code: string, message: string) => JSON.stringify({ ok: false, error: { code, message } })

function errorOf(outcome: Extract<ModuleOutcome, { ok: false }>) {
  return { code: outcome.limit === true ? 'limit' : 'failed', message: outcome.error }
}

async function runEvent(message: Extract<Incoming, { type: 'event' }>): Promise<void> {
  const { eventId, limits } = message
  let calls = 0
  let nextCallId = 1
  const call = async (text: string): Promise<string> => {
    calls += 1
    if (calls > limits.calls) {
      return envelope('limit', `An event makes at most ${String(limits.calls)} calls into Seti`)
    }
    if (Buffer.byteLength(text) > limits.callArgsBytes) {
      return envelope('limit', `A call's arguments are at most ${String(limits.callArgsBytes / 1024)} KB as JSON`)
    }
    const { op, args } = JSON.parse(text) as { op: unknown; args: unknown }
    if (typeof op !== 'string' || op.length > 40) {
      return envelope('invalid', 'A call names its op as a string')
    }
    const callId = nextCallId++
    const reply = new Promise<string>((resolve) => {
      pending.set(callId, (answer) => {
        pending.delete(callId)
        resolve(JSON.stringify(answer.ok ? { ok: true, value: answer.value } : { ok: false, error: answer.error }))
      })
    })
    send({ type: 'call', eventId, callId, op, args })
    return reply
  }
  const outcome = await engine.runModule({
    script: message.script,
    entry: LOGIC_ENTRY,
    input: { event: message.event, ctx: message.ctx },
    host: { call: { kind: 'async', call } },
    limits: {
      timeoutMs: limits.wallMs,
      memoryBytes: limits.memoryBytes,
      cpuSliceMs: limits.cpuSliceMs,
      cpuTotalMs: limits.cpuTotalMs,
      logLines: limits.logLines,
      logLineChars: limits.logLineChars,
      outputBytes: limits.outputBytes,
    },
  })
  pending.clear()
  const usage = { cpuMs: outcome.cpuMs, calls }
  if (outcome.ok) {
    send({ type: 'done', eventId, ok: true, value: outcome.value, logs: outcome.logs, usage })
    return
  }
  const aborted = outcome.aborted === true ? { aborted: true } : {}
  send({ type: 'done', eventId, ok: false, error: errorOf(outcome), logs: outcome.logs, usage, ...aborted })
  if (outcome.aborted === true) {
    exit(0)
  }
}

function receive(line: string): void {
  const message = JSON.parse(line) as Incoming
  if (message.type === 'reply') {
    pending.get(message.callId)?.(message)
    return
  }
  if (busy) {
    die('Seti sent an event while another one ran')
  }
  busy = true
  void runEvent(message).finally(() => {
    busy = false
  })
}

lockDown()
let buffered = ''
stdin.setEncoding('utf8')
stdin.on('data', (chunk: string) => {
  buffered += chunk
  for (let end = buffered.indexOf('\n'); end !== -1; end = buffered.indexOf('\n')) {
    const line = buffered.slice(0, end)
    buffered = buffered.slice(end + 1)
    receive(line)
  }
  if (buffered.length > config.lineBytes) {
    die(`a line from Seti is over ${String(config.lineBytes)} bytes`)
  }
})
stdin.on('end', () => exit(0))
send({ type: 'ready' })
