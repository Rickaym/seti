import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { SharedToolManifest, ToolInputProperty } from '@seti/shared'

/**
 * The MCP server that offers an agent its shared tools. Claude Code starts it as the agent's own
 * child, so it and every script it runs live where the agent's commands live: in the agent's
 * sandbox when it has one. It imports only Node builtins and takes the tool folders as arguments.
 */
const PROTOCOL = '2025-06-18'
const OUTPUT_MAX = 256 * 1024
const STDERR_MAX = 4000
const KILL_GRACE_MS = 2000

interface LoadedTool {
  manifest: SharedToolManifest
  script: string
}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

function loadTool(dir: string): LoadedTool {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'tool.json'), 'utf8')) as SharedToolManifest
  return { manifest, script: path.join(dir, manifest.file) }
}

function typeProblem(value: unknown, type: ToolInputProperty['type']): boolean {
  switch (type) {
    case 'string':
      return typeof value !== 'string'
    case 'number':
      return typeof value !== 'number' || !Number.isFinite(value)
    case 'integer':
      return typeof value !== 'number' || !Number.isInteger(value)
    case 'boolean':
      return typeof value !== 'boolean'
    case 'array':
      return !Array.isArray(value)
    case 'object':
      return !isObject(value)
  }
}

function objectProblem(
  value: Json,
  schema: Pick<ToolInputProperty, 'properties' | 'required'>,
  at: string,
): string | null {
  const properties = schema.properties ?? {}
  const missing = (schema.required ?? []).find((name) => !(name in value))
  if (missing !== undefined) {
    return `${at}${missing} is required`
  }
  for (const [name, entry] of Object.entries(value)) {
    const property = properties[name]
    const problem =
      property === undefined ? `${at}${name} is not an argument` : valueProblem(entry, property, at + name)
    if (problem !== null) {
      return problem
    }
  }
  return null
}

/** Why a value does not fit its schema, or null when it does. */
function valueProblem(value: unknown, schema: ToolInputProperty, at: string): string | null {
  if (typeProblem(value, schema.type)) {
    return `${at} must be ${/^[aeio]/.test(schema.type) ? 'an' : 'a'} ${schema.type}`
  }
  if (schema.enum !== undefined && !schema.enum.some((allowed) => allowed === value)) {
    return `${at} must be one of ${schema.enum.join(', ')}`
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    const { items } = schema
    const problems = value.map((entry, index) => valueProblem(entry, items, `${at}[${String(index)}]`))
    return problems.find((problem) => problem !== null) ?? null
  }
  return isObject(value) && schema.properties !== undefined ? objectProblem(value, schema, `${at}.`) : null
}

interface Outcome {
  text: string
  failed: boolean
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[cut at ${String(max)} characters]`
}

/** Runs the script once with the arguments on stdin; no shell, and its whole group ends on time. */
async function runTool(tool: LoadedTool, args: Json): Promise<Outcome> {
  const [program, ...rest] = [...tool.manifest.run, tool.script]
  return new Promise((resolve) => {
    const child = spawn(program, rest, { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const stopGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-(child.pid ?? 0), signal)
      } catch {
        child.kill(signal)
      }
    }
    const seconds = tool.manifest.timeout_seconds
    const timer = setTimeout(() => {
      timedOut = true
      stopGroup('SIGTERM')
      setTimeout(() => {
        stopGroup('SIGKILL')
      }, KILL_GRACE_MS).unref()
    }, seconds * 1000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString('utf8')}`.slice(0, OUTPUT_MAX + 1)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-STDERR_MAX)
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(JSON.stringify(args))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ text: `The tool could not start: ${e.message}`, failed: true })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) {
        resolve({ text: `The tool was stopped after ${String(seconds)} seconds.\n${stderr}`.trim(), failed: true })
      } else if (code === 0) {
        resolve({ text: clip(stdout, OUTPUT_MAX), failed: false })
      } else {
        const how = signal ?? `exit ${String(code)}`
        resolve({ text: `The tool failed (${how}).\n${stderr}\n${clip(stdout, STDERR_MAX)}`.trim(), failed: true })
      }
    })
  })
}

/** The result as MCP text, and as structured content too when the script printed a JSON object. */
function callResult({ text, failed }: Outcome): Json {
  const result: Json = { content: [{ type: 'text', text }], isError: failed }
  if (!failed) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (isObject(parsed)) {
        result.structuredContent = parsed
      }
    } catch {
      return result
    }
  }
  return result
}

const byName = new Map(
  process.argv
    .slice(2)
    .map(loadTool)
    .map((tool) => [tool.manifest.name, tool] as const),
)

function listed(): Json[] {
  return [...byName.values()].map(({ manifest }) => ({
    name: manifest.name,
    description: manifest.description,
    inputSchema: manifest.input,
    annotations: { title: manifest.name, readOnlyHint: !manifest.writes, openWorldHint: manifest.writes },
  }))
}

async function call(params: unknown): Promise<Json> {
  const name = isObject(params) ? params.name : undefined
  const tool = typeof name === 'string' ? byName.get(name) : undefined
  if (tool === undefined) {
    return callResult({ text: `No shared tool is named ${String(name)}`, failed: true })
  }
  const args = isObject(params) && isObject(params.arguments) ? params.arguments : {}
  const problem = objectProblem(args, tool.manifest.input, '')
  if (problem !== null) {
    return callResult({ text: `Bad arguments: ${problem}`, failed: true })
  }
  return callResult(await runTool(tool, args))
}

class UnknownMethod extends Error {}

async function answer(method: string, params: unknown): Promise<Json> {
  switch (method) {
    case 'initialize': {
      const asked = isObject(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL
      return {
        protocolVersion: asked,
        capabilities: { tools: {} },
        serverInfo: { name: 'seti-shared-tools', version: '1.0.0' },
      }
    }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: listed() }
    case 'tools/call':
      return call(params)
    default:
      throw new UnknownMethod(method)
  }
}

const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603

async function handle(line: string): Promise<void> {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (!isObject(message) || typeof message.method !== 'string' || !('id' in message)) {
    return
  }
  const reply = (body: Json) => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...body })}\n`)
  }
  try {
    reply({ result: await answer(message.method, message.params) })
  } catch (e) {
    const unknown = e instanceof UnknownMethod
    const text = unknown ? `Unknown method ${message.method}` : String(e)
    reply({ error: { code: unknown ? METHOD_NOT_FOUND : INTERNAL_ERROR, message: text } })
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  void handle(line)
})
