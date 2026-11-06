import { readFileSync, writeSync } from 'node:fs'
import { registerHooks } from 'node:module'
import type { RunnerReply, RunnerRequest } from './protocol.js'

/** Builtins a script may import: pure helpers with no files, network, processes or workers. */
const ALLOWED = new Set(['assert', 'buffer', 'events', 'path', 'querystring', 'string_decoder', 'url', 'util'])

const exit: (code: number) => never = process.exit.bind(process)
const getBuiltin = process.getBuiltinModule.bind(process)

function send(answer: RunnerReply): never {
  writeSync(1, `${JSON.stringify(answer)}\n`)
  exit(0)
}

const request = JSON.parse(readFileSync(0, 'utf8')) as RunnerRequest
const { limits } = request
const logs: string[] = []

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`)

const builtinName = (specifier: string) => specifier.replace(/^node:/, '').split('/')[0] ?? ''

function refuse(specifier: string): never {
  throw new Error(`Reminder scripts cannot import ${specifier}`)
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('data:') || ALLOWED.has(builtinName(specifier))) {
      return nextResolve(specifier, context)
    }
    return refuse(specifier)
  },
})

const log = (...values: unknown[]) => {
  if (logs.length < limits.logLines) {
    const line = values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')
    logs.push(clip(line, limits.logLineChars))
  }
}

/** Takes away what reaches past this process: network globals, signals, stdio and the loader. */
function lockDown(): void {
  for (const name of ['fetch', 'WebSocket', 'EventSource', 'navigator']) {
    Reflect.deleteProperty(globalThis, name)
  }
  const shim = Object.freeze({
    env: Object.freeze({}),
    platform: process.platform,
    version: process.version,
    getBuiltinModule: (id: string): unknown => (ALLOWED.has(builtinName(id)) ? getBuiltin(id) : refuse(id)),
  })
  Object.defineProperty(globalThis, 'process', { value: shim, writable: false, configurable: false })
  const console = Object.freeze({ log, info: log, warn: log, error: log, debug: log })
  Object.defineProperty(globalThis, 'console', { value: console, writable: false, configurable: false })
}

type Remind = (context: unknown) => unknown

async function load(script: string): Promise<Remind> {
  try {
    const url = `data:text/javascript;base64,${Buffer.from(script).toString('base64')}`
    const loaded = (await import(url)) as { default?: unknown }
    if (typeof loaded.default === 'function') {
      return loaded.default as Remind
    }
    throw new Error('Export the reminder function: export default function remind(context) { ... }')
  } catch (e) {
    if (!(e instanceof SyntaxError && /return/i.test(e.message))) {
      throw e
    }
  }
  const AsyncFunction = async function body() {
    await Promise.resolve()
  }.constructor as new (source: string) => () => Promise<unknown>
  const returned = await new AsyncFunction(script)()
  if (typeof returned !== 'function') {
    throw new Error('A top-level return must return the reminder function')
  }
  return returned as Remind
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function reply(value: unknown): RunnerReply {
  const answer = isRecord(value) ? value : { message: value }
  const unknownKeys = Object.keys(answer).filter((key) => key !== 'message' && key !== 'state')
  const { message } = answer
  if (unknownKeys.length > 0 || !(message === null || message === undefined || typeof message === 'string')) {
    return { ok: false, error: 'Return a string, null, or { message, state }', logs }
  }
  if (typeof message === 'string' && message.length > limits.messageMaxChars) {
    return { ok: false, error: `The message is over ${String(limits.messageMaxChars)} characters`, logs }
  }
  const text = typeof message === 'string' ? message.trim() : ''
  if (!('state' in answer) || answer.state === undefined) {
    return { ok: true, message: text === '' ? null : text, logs }
  }
  const state = JSON.stringify(answer.state) as string | undefined
  if (state === undefined) {
    return { ok: false, error: 'The state must be JSON, such as an object, a list or a number', logs }
  }
  if (Buffer.byteLength(state) > limits.stateMaxBytes) {
    return { ok: false, error: `The state is over ${String(limits.stateMaxBytes / 1024)} KB as JSON`, logs }
  }
  return { ok: true, message: text === '' ? null : text, state: JSON.parse(state) as unknown, logs }
}

const describe = (e: unknown) =>
  clip(e instanceof Error ? `${e.name}: ${e.message}` : `Uncaught ${String(e)}`, limits.errorChars)

lockDown()
writeSync(1, '{"started":true}\n')
try {
  const remind = await load(request.script)
  send(reply(await remind(request.input)))
} catch (e) {
  send({ ok: false, error: describe(e), logs })
}
