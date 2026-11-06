import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSSyncVariant,
} from 'quickjs-emscripten-core'

/** What an async host function resolves to: a string, or a flat object of strings and numbers. */
type HostValue = string | Readonly<Record<string, string | number>>

/** A function the script may call on the host; it takes one string, usually JSON. */
export type HostFunction =
  | { kind: 'sync'; call: (arg: string) => string | undefined }
  | { kind: 'async'; call: (arg: string, signal: AbortSignal) => Promise<HostValue> }

export interface ModuleLimits {
  timeoutMs: number
  memoryBytes: number
  cpuSliceMs: number
  cpuTotalMs: number
  logLines: number
  logLineChars: number
  outputBytes: number
}

/** How to run a module: its file name, the prelude that calls it, and what it must export. */
export interface ModuleEntry {
  /** Error lines name it, such as (line 3). */
  file: string
  /** Source of `(host, input, main) => result`: host functions, input JSON, the default export. */
  prelude: string
  /** The type the default export must have, and the error when it does not. */
  main: { type: 'function' | 'object'; missing: string }
  /** A script run before the module, so the module never sees what it takes away. */
  lockdown?: string
}

/** One run: the module's source, how to call it, its input, the host functions and the limits. */
export interface ModuleRun {
  script: string
  entry: ModuleEntry
  input: unknown
  host: Readonly<Record<string, HostFunction>>
  limits: ModuleLimits
}

/**
 * `aborted` means the engine itself failed; its thread or process should not run another script.
 * `limit` means the script ran past one of its limits rather than failing on its own.
 */
export type ModuleOutcome =
  | { ok: true; value: unknown; logs: string[]; cpuMs: number }
  | { ok: false; error: string; logs: string[]; cpuMs: number; aborted?: true; limit?: true }

const STRINGIFY = '(value) => JSON.stringify(value === undefined ? null : value)'

class ScriptError extends Error {
  /** The engine itself failed, such as a trap on exhausted memory; its thread should retire. */
  aborted = false
  /** The script ran past a limit: time, compute, memory or output size. */
  limit = false
}

const LIMIT_TEXT = /^The script (ran out of memory|ran over its|computed for over|used over|returned over)/

const WASM_PAGE = 64 * 1024
/** Past this share of its maximum, a failed allocation may leave QuickJS no room for an error. */
const NEARLY_FULL = 0.75
/** What the engine needs before any script runs; a smaller memory fails to instantiate. */
const BASE_PAGES = 256

const isSyncVariant = (value: unknown): value is QuickJSSyncVariant =>
  typeof value === 'object' && value !== null && 'type' in value && value.type === 'sync' && 'importFFI' in value

/** The package's types describe its CommonJS build, so its default may sit one level deeper. */
async function loadVariant(): Promise<QuickJSSyncVariant> {
  let value: unknown = await import('@jitl/quickjs-wasmfile-release-sync')
  for (let depth = 0; depth < 2 && !isSyncVariant(value); depth++) {
    value = typeof value === 'object' && value !== null && 'default' in value ? value.default : undefined
  }
  if (!isSyncVariant(value)) {
    throw new Error('The QuickJS engine did not load')
  }
  return value
}

let variant: Promise<QuickJSSyncVariant> | null = null

/** Loads the engine's code ahead of the first run, so a locked-down process can drop access after. */
export async function loadEngine(): Promise<void> {
  variant ??= loadVariant()
  await variant
}

/** A fresh engine with capped wasm memory; QuickJS's own limit counts allocations, not bytes. */
async function newEngine(memoryBytes: number) {
  variant ??= loadVariant()
  const maximum = Math.max(BASE_PAGES + 1, Math.ceil(memoryBytes / WASM_PAGE))
  const wasmMemory = new WebAssembly.Memory({ initial: BASE_PAGES, maximum })
  const quickjs = await newQuickJSWASMModuleFromVariant(newVariant(await variant, { wasmMemory }))
  return { quickjs, nearlyFull: () => wasmMemory.buffer.byteLength >= maximum * WASM_PAGE * NEARLY_FULL }
}

/** WebAssembly.RuntimeError: a trap, or emscripten's abort; Node's types do not declare it. */
const isTrap = (e: unknown) => e instanceof Error && e.name === 'RuntimeError'

/** Deep recursion can exhaust the host's stack inside the engine before QuickJS's own check. */
const isHostStackOverflow = (e: unknown) => e instanceof RangeError && /call stack/i.test(e.message)

function scriptError(text: string): ScriptError {
  const error = new ScriptError(text)
  error.limit = LIMIT_TEXT.test(text)
  return error
}

const outOfMemory = (limits: ModuleLimits) =>
  `The script ran out of memory (${String(Math.round(limits.memoryBytes / 1024 / 1024))} MB)`

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 3)}...`)

interface RunState {
  limits: ModuleLimits
  budget: string | null
  /** Memory is nearly exhausted, so a thrown null is QuickJS failing to build its error. */
  memoryFull: boolean
  /** Finds the script's own line in a stack. */
  line: RegExp
}

function describe(ctx: QuickJSContext, handle: QuickJSHandle, state: RunState): string {
  const { limits, budget } = state
  const dumped: unknown = ctx.dump(handle)
  if (dumped === null && state.memoryFull) {
    return outOfMemory(limits)
  }
  if (typeof dumped !== 'object' || dumped === null) {
    return clip(`Uncaught ${String(dumped)}`, 500)
  }
  const { name, message, stack } = dumped as { name?: unknown; message?: unknown; stack?: unknown }
  const text = typeof message === 'string' ? message : ''
  if (name === 'InternalError' && text === 'interrupted') {
    return budget ?? 'The script was stopped'
  }
  if (name === 'InternalError' && text === 'out of memory') {
    return outOfMemory(limits)
  }
  const where = typeof stack === 'string' ? state.line.exec(stack)?.[1] : undefined
  const line = where === undefined ? '' : ` (line ${where})`
  return clip(`${typeof name === 'string' ? name : 'Error'}: ${text}${line}`, 500)
}

const lineOf = (file: string) => new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`)

/**
 * Runs a module once in a fresh QuickJS instance that has only the host functions it is given,
 * plus `log`, and returns what its prelude returns as JSON.
 */
export async function runModule({ script, entry, input, host, limits }: ModuleRun): Promise<ModuleOutcome> {
  const logs: string[] = []
  const { quickjs, nearlyFull } = await newEngine(limits.memoryBytes)
  const runtime: QuickJSRuntime = quickjs.newRuntime()
  const started = Date.now()
  const deadline = started + limits.timeoutMs
  const abort = new AbortController()
  let sliceStart = started
  let cpuUsed = 0
  let budget: string | null = null
  let alive = true
  runtime.setMemoryLimit(limits.memoryBytes)
  runtime.setMaxStackSize(512 * 1024)
  runtime.setInterruptHandler(() => {
    const now = Date.now()
    if (now > deadline) {
      budget = `The script ran over its ${String(limits.timeoutMs / 1000)} s timeout`
    } else if (now - sliceStart > limits.cpuSliceMs) {
      budget = `The script computed for over ${String(limits.cpuSliceMs)} ms without awaiting`
    } else if (cpuUsed + now - sliceStart > limits.cpuTotalMs) {
      budget = `The script used over ${String(limits.cpuTotalMs / 1000)} s of compute`
    }
    return budget !== null
  })
  const ctx = runtime.newContext()
  let stopRun: (error: ScriptError) => void
  const failure = new Promise<never>((_resolve, reject) => {
    stopRun = reject
  })
  failure.catch(() => undefined)
  const line = lineOf(entry.file)

  const enter = <T>(work: () => T): T => {
    sliceStart = Date.now()
    try {
      return work()
    } finally {
      cpuUsed += Date.now() - sliceStart
    }
  }
  const explain = (handle: QuickJSHandle) => describe(ctx, handle, { limits, budget, memoryFull: nearlyFull(), line })
  /** The engine failed under the script; its state is unknown, so the instance is not reused. */
  const aborted = (e: unknown): ScriptError | null => {
    if (!isTrap(e) && !isHostStackOverflow(e)) {
      return null
    }
    const error = isTrap(e) ? scriptError(outOfMemory(limits)) : new ScriptError(`RangeError: ${(e as Error).message}`)
    error.aborted = true
    return error
  }
  const fail = (handle: QuickJSHandle): never => {
    const text = explain(handle)
    handle.dispose()
    throw scriptError(text)
  }
  const unwrap = (result: ReturnType<QuickJSContext['evalCode']>): QuickJSHandle =>
    result.error === undefined ? result.value : fail(result.error)
  /** Engine work off the main await chain; a trap there ends the run instead of escaping. */
  const guarded = (work: () => void) => {
    if (!alive) {
      return
    }
    try {
      work()
    } catch (e) {
      alive = false
      stopRun(aborted(e) ?? scriptError(String(e)))
    }
  }
  const pump = () => {
    guarded(() => {
      const jobs = enter(() => runtime.executePendingJobs())
      if (jobs.error !== undefined) {
        const text = explain(jobs.error)
        jobs.error.dispose()
        stopRun(scriptError(text))
      }
    })
  }
  /** A flat value goes in prop by prop, so the engine never holds a second copy of a long string. */
  const valueHandle = (value: HostValue): QuickJSHandle => {
    if (typeof value === 'string') {
      return ctx.newString(value)
    }
    const object = ctx.newObject()
    for (const [name, prop] of Object.entries(value)) {
      const handle = typeof prop === 'number' ? ctx.newNumber(prop) : ctx.newString(prop)
      ctx.setProp(object, name, handle)
      handle.dispose()
    }
    return object
  }
  const asyncFn = (name: string, call: (arg: string, signal: AbortSignal) => Promise<HostValue>) =>
    ctx.newFunction(name, (argHandle) => {
      const deferred = ctx.newPromise()
      call(ctx.getString(argHandle), abort.signal).then(
        (value) => {
          guarded(() => {
            const handle = valueHandle(value)
            deferred.resolve(handle)
            handle.dispose()
          })
        },
        (e: unknown) => {
          guarded(() => {
            const error = ctx.newError(e instanceof Error ? e.message : String(e))
            deferred.reject(error)
            error.dispose()
          })
        },
      )
      void deferred.settled.then(() => {
        guarded(() => {
          deferred.dispose()
        })
        pump()
      })
      return deferred.handle
    })
  const syncFn = (name: string, call: (arg: string) => string | undefined) =>
    ctx.newFunction(name, (argHandle) => {
      try {
        const value = call(ctx.getString(argHandle))
        return value === undefined ? undefined : ctx.newString(value)
      } catch (e) {
        return { error: ctx.newError(e instanceof Error ? e.message : String(e)) }
      }
    })
  const log: HostFunction = {
    kind: 'sync',
    call: (text) => {
      if (logs.length < limits.logLines) {
        logs.push(clip(text, limits.logLineChars))
      }
      return undefined
    },
  }

  const hostObject = ctx.newObject()
  for (const [name, fn] of Object.entries<HostFunction>({ ...host, log })) {
    const handle = fn.kind === 'async' ? asyncFn(name, fn.call) : syncFn(name, fn.call)
    ctx.setProp(hostObject, name, handle)
    handle.dispose()
  }

  /** A promise's value once the script's jobs settle it; other values pass through. */
  const settle = async (handle: QuickJSHandle): Promise<QuickJSHandle> => {
    const settled = ctx.resolvePromise(handle)
    pump()
    const result = await Promise.race([settled, failure])
    return result.error === undefined ? result.value : fail(result.error)
  }
  const timer = setTimeout(() => {
    budget ??= `The script ran over its ${String(limits.timeoutMs / 1000)} s timeout`
    stopRun(scriptError(budget))
  }, limits.timeoutMs)

  try {
    if (entry.lockdown !== undefined) {
      const locked = enter(() => unwrap(ctx.evalCode(entry.lockdown ?? '', 'lockdown.js')))
      locked.dispose()
    }
    const evaluated = enter(() => unwrap(ctx.evalCode(script, entry.file, { type: 'module' })))
    const exports = await settle(evaluated)
    const main = ctx.getProp(exports, 'default')
    if (ctx.typeof(main) !== entry.main.type) {
      throw new ScriptError(entry.main.missing)
    }
    const prelude = enter(() => unwrap(ctx.evalCode(entry.prelude, 'prelude.js')))
    const inputText = ctx.newString(JSON.stringify(input))
    const returned = enter(() => unwrap(ctx.callFunction(prelude, ctx.undefined, hostObject, inputText, main)))
    const value = await settle(returned)
    const stringify = enter(() => unwrap(ctx.evalCode(STRINGIFY, 'stringify.js')))
    const text = enter(() => unwrap(ctx.callFunction(stringify, ctx.undefined, value)))
    const json = ctx.getString(text)
    if (Buffer.byteLength(json) > limits.outputBytes) {
      throw scriptError(`The script returned over ${String(Math.round(limits.outputBytes / 1024))} KB`)
    }
    // The instance is dropped whole: this QuickJS build's JS_FreeRuntime asserts after a GC in a job.
    return { ok: true, value: JSON.parse(json) as unknown, logs, cpuMs: cpuUsed }
  } catch (e) {
    const error = aborted(e) ?? e
    if (!(error instanceof ScriptError)) {
      throw error
    }
    const flags = {
      ...(error.aborted ? { aborted: true as const } : {}),
      ...(error.limit ? { limit: true as const } : {}),
    }
    return { ok: false, error: error.message, logs, cpuMs: cpuUsed, ...flags }
  } finally {
    alive = false
    clearTimeout(timer)
    abort.abort()
  }
}
