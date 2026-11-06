import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { ReminderContext } from './protocol.js'
import { isolation, nodeArgs, type Isolation } from '../script-sandbox.js'
import { runSandboxed, type SandboxLimits } from './sandbox.js'

const LIMITS: SandboxLimits = {
  timeoutMs: 2000,
  startupMs: 20_000,
  heapMb: 64,
  memoryMb: 256,
  outputBytes: 64 * 1024,
  messageMaxChars: 200,
  stateMaxBytes: 1024,
  logLines: 3,
  logLineChars: 40,
  errorChars: 300,
}

const CONTEXT: ReminderContext = { now: '2026-10-19T09:00:00.000Z', lastRunAt: null, lastOutput: null, state: null }

const modes: Isolation[] = isolation().isolation === 'bwrap' ? ['node', 'bwrap'] : ['node']

describe('the Node permission flags alone', () => {
  const probe = (code: string) => spawnSync(process.execPath, [...nodeArgs(64), '-e', code], { env: {} })

  it('refuse reading a file', () => {
    const run = probe("require('fs').readFileSync('/etc/hostname')")
    expect(run.status).not.toBe(0)
    expect(run.stderr.toString()).toContain('ERR_ACCESS_DENIED')
  })

  it('refuse starting a process', () => {
    const run = probe("require('child_process').execFileSync('/bin/true')")
    expect(run.status).not.toBe(0)
    expect(run.stderr.toString()).toContain('ERR_ACCESS_DENIED')
  })
})

describe.each(modes)('a reminder script isolated by %s', (mode) => {
  const run = async (script: string, context: Partial<ReminderContext> = {}, limits = LIMITS) =>
    runSandboxed(script, { ...CONTEXT, ...context }, limits, mode)

  it('returns the message from its default export, with its context', async () => {
    const result = await run('export default async ({ now, lastOutput }) => `It is ${now}; last ${lastOutput}`', {
      lastOutput: 'hello',
    })
    expect(result).toMatchObject({ outcome: 'ok', message: 'It is 2026-10-19T09:00:00.000Z; last hello' })
  })

  it('takes a function from a top-level return, and null or blank as nothing to deliver', async () => {
    expect(await run('return () => null')).toMatchObject({ outcome: 'empty', message: null })
    expect(await run("export default () => '   '")).toMatchObject({ outcome: 'empty', message: null })
    expect(await run("return async () => 'from a return'")).toMatchObject({ outcome: 'ok', message: 'from a return' })
  })

  it('round trips its state and keeps its console lines, capped', async () => {
    const script = `export default ({ state }) => {
      for (let i = 0; i < 10; i++) console.log('line', i, 'x'.repeat(60))
      const count = (state?.count ?? 0) + 1
      return { message: 'run ' + count, state: { count } }
    }`
    const first = await run(script)
    expect(first).toMatchObject({ outcome: 'ok', message: 'run 1', state: { count: 1 } })
    expect(first.logs).toHaveLength(3)
    expect(first.logs[0]).toHaveLength(40)
    const second = await run(script, { state: 'state' in first ? first.state : null })
    expect(second).toMatchObject({ message: 'run 2', state: { count: 2 } })
  })

  it('stops a script that runs past its timeout', async () => {
    const result = await run('export default () => { for (;;) {} }')
    expect(result).toMatchObject({ outcome: 'timeout', error: 'The script ran over its 2 s timeout' })
    expect(result.duration_ms).toBeLessThan(LIMITS.startupMs)
  })

  it('cannot read a file, through an import or the builtin loader', async () => {
    const imported = await run("import fs from 'node:fs'\nexport default () => fs.readFileSync('/etc/passwd', 'utf8')")
    expect(imported).toMatchObject({ outcome: 'error', error: 'Error: Reminder scripts cannot import node:fs' })
    const builtin = await run("export default () => process.getBuiltinModule('fs').readFileSync('/etc/passwd', 'utf8')")
    expect(builtin).toMatchObject({ outcome: 'error', error: 'Error: Reminder scripts cannot import fs' })
    const file = await run("export default async () => (await import('file:///etc/passwd')).default")
    expect(file).toMatchObject({ outcome: 'error', error: 'Error: Reminder scripts cannot import file:///etc/passwd' })
  })

  it('cannot start a process or a worker', async () => {
    const spawn = await run(
      "export default () => process.getBuiltinModule('node:child_process').execSync('id').toString()",
    )
    expect(spawn).toMatchObject({ outcome: 'error', error: 'Error: Reminder scripts cannot import node:child_process' })
    const worker = await run("import { Worker } from 'node:worker_threads'\nexport default () => 'x'")
    expect(worker).toMatchObject({ outcome: 'error' })
  })

  it('has no network, environment or process handles', async () => {
    const script = `export default async () => JSON.stringify([
      typeof fetch, typeof WebSocket, process.env, typeof process.kill, typeof process.stdout,
      await import('node:net').then(() => 'net', (e) => e.message),
    ])`
    const result = await run(script)
    expect(result).toMatchObject({ outcome: 'ok' })
    expect(JSON.parse('message' in result ? (result.message ?? '') : '')).toEqual([
      'undefined',
      'undefined',
      {},
      'undefined',
      'undefined',
      'Reminder scripts cannot import node:net',
    ])
  })

  it('refuses an oversized message or state, and output past its cap', async () => {
    expect(await run("export default () => 'x'.repeat(201)")).toMatchObject({
      outcome: 'error',
      error: 'The message is over 200 characters',
    })
    expect(await run("export default () => ({ message: 'ok', state: 'x'.repeat(2000) })")).toMatchObject({
      outcome: 'error',
      error: 'The state is over 1 KB as JSON',
    })
    expect(await run("export default () => ({ message: 'ok', state: () => 1 })")).toMatchObject({
      outcome: 'error',
    })
    const flood = await run("export default () => 'x'.repeat(150)", {}, { ...LIMITS, outputBytes: 100 })
    expect(flood).toMatchObject({ outcome: 'error', error: 'The script wrote over 0 KB' })
  })

  it('stops a script that holds more memory than its cap', async () => {
    const script = `export default () => {
      const held = Buffer.alloc(400 * 1024 * 1024, 1)
      const until = Date.now() + 1500
      while (Date.now() < until) {}
      return String(held.length)
    }`
    expect(await run(script)).toMatchObject({ outcome: 'error', error: 'The script used over 256 MB of memory' })
  })

  it('says what went wrong in a script that throws or does not parse', async () => {
    expect(await run("export default () => { throw new TypeError('bad input') }")).toMatchObject({
      outcome: 'error',
      error: 'TypeError: bad input',
    })
    expect(await run('export default (')).toMatchObject({ outcome: 'error' })
    expect(await run('export const x = 1')).toMatchObject({ outcome: 'error' })
    expect(await run('export default () => 42')).toMatchObject({
      outcome: 'error',
      error: 'Return a string, null, or { message, state }',
    })
  })
})
