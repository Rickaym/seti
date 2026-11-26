import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GEMINI_SETTINGS_DEFAULTS, type Task } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { endSession } from './session-control.js'
import { geminiSettings } from './store/gemini-settings.js'
import { canSandbox } from './test-codex-proof.js'
import { clearConnections } from './test-connections.js'
import { GEMINI_HOST, geminiProofRun } from './test-gemini-proof.js'

const ENTRY = process.env.SETI_GEMINI_BIN ?? ''
const runs = ENTRY !== '' && canSandbox()

it.runIf(process.env.CI === 'true')('runs in CI, which has the pinned Gemini CLI and a sandbox', () => {
  expect(runs).toBe(true)
})

describe.skipIf(!runs)("a Gemini agent's reads in Seti's sandbox", () => {
  let run: Awaited<ReturnType<typeof geminiProofRun>>
  let task: Task
  let seen: Awaited<ReturnType<typeof run.reads>>

  beforeAll(async () => {
    createApp()
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seti-gemini-proof-')))
    run = await geminiProofRun(scratch, ENTRY)
    task = await run.agent()
    seen = await run.reads(task)
  }, 180_000)

  afterAll(async () => {
    await endSession(task.id)
    run.close()
    await geminiSettings.set(GEMINI_SETTINGS_DEFAULTS)
    await clearConnections()
  })

  const resultOf = (command: string) => seen.results[run.commands.indexOf(command)] ?? ''

  it('runs every read, and those that look inside its folder without asking', () => {
    expect(seen.results).toHaveLength(run.commands.length + 4)
    expect(resultOf('cat inside.txt')).toContain('PROOF_INSIDE')
    const unasked = ['cat inside.txt', 'cat link.txt', 'cat rel-link.txt', 'cat outdir/secret.txt', 'cat host-environ']
    expect(
      seen.asked.filter((summary) => unasked.includes(summary)),
      'so the sandbox alone stops them',
    ).toEqual([])
  })

  it("sees no folder beside its own and none of the host home's", () => {
    expect(resultOf('ls -la ..')).not.toContain('outside')
    const listed = resultOf(run.commands.find((each) => each.startsWith('ls -la /')) ?? '')
    const own = fs.readdirSync(os.homedir()).filter((name) => !name.startsWith('.'))
    expect(own.filter((name) => listed.includes(` ${name}\n`))).toEqual([])
  })

  it('never reads a secret outside its folders, even with every call allowed', () => {
    const told = [run.model.told(), ...seen.results].join('\n')
    const leaked = Object.entries({ ...run.secrets, key: run.key }).filter(([, value]) => told.includes(value))
    expect(
      leaked.map(([where]) => where),
      'secrets the model was told, by place; values stay out of logs',
    ).toEqual([])
  })

  it('reaches only the Gemini API, with the key the proxy adds', () => {
    expect(new Set(run.model.authorizations)).toEqual(new Set([run.key]))
    expect(new Set(run.model.dialled)).toEqual(new Set([GEMINI_HOST]))
    // Gemini CLI 0.71.1 logs extension events to Clearcut whatever its usage statistics setting.
    expect(run.model.refused.filter((host) => host !== 'play.googleapis.com')).toEqual([])
  })
})
