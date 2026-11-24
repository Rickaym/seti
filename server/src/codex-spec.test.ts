import fs from 'node:fs'
import path from 'node:path'
import { CODEX_SETTINGS_DEFAULTS } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { sql, tasks } from './db.js'
import { launchPlan } from './launch-plan.js'
import { setupKey, startingSpec } from './session-spec.js'
import { codexSettings } from './store/codex-settings.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-codex-spec-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

const ID = 'codex-spec-agent'
await tasks.insert({
  id: ID,
  title: 'Codex spec',
  repo_id: null,
  cwd: '/tmp',
  worktree: false,
  pr_urls: [],
  sandbox: true,
})
await sql`UPDATE task SET runtime = 'codex', requested_model = 'gpt-5.5' WHERE id = ${ID}`

/** A program of the user's that reports the pinned version, as `codex --version` does. */
const PROGRAM = path.join(scratch, 'bin', 'codex')
fs.mkdirSync(path.dirname(PROGRAM))
fs.writeFileSync(PROGRAM, '#!/bin/sh\necho "codex-cli 0.171.0"\n', { mode: 0o755 })
const on = { ...CODEX_SETTINGS_DEFAULTS, enabled: true, program: PROGRAM, default_effort: 'medium' }

const taskOf = async () => {
  const task = await tasks.get(ID)
  if (task === undefined) {
    throw new Error('the task was not stored')
  }
  return task
}

afterAll(async () => {
  await codexSettings.set(CODEX_SETTINGS_DEFAULTS)
})

describe("a Codex agent's spec and plan", () => {
  it("starts nothing while Codex is off or Seti's copy is not installed", async () => {
    await codexSettings.set(CODEX_SETTINGS_DEFAULTS)
    await expect(startingSpec(await taskOf())).rejects.toThrow(/Codex is off/)
    await codexSettings.set({ ...on, program: null })
    await expect(startingSpec(await taskOf())).rejects.toThrow(/Codex 0\.171\.0 is not installed yet/)
  })

  it("starts the program the user named, with the agent's model and the default effort", async () => {
    await codexSettings.set(on)
    const { spec, key } = await startingSpec(await taskOf())
    expect(spec).toMatchObject({
      runtime: 'codex',
      mode: 'default',
      vendor: { binary: PROGRAM, model: 'gpt-5.5', effort: 'medium' },
    })
    expect(JSON.parse(key)).toMatchObject({ runtime: 'codex', codex: spec.vendor })
    await sql`UPDATE task SET requested_model = 'gpt-5.6-sol' WHERE id = ${ID}`
    expect(await setupKey(await taskOf())).not.toBe(key)
  })

  it("mounts the program's folder read-only and keeps Anthropic out of its reach", async () => {
    await codexSettings.set(on)
    const plan = await launchPlan(await taskOf())
    expect(plan.grant).toMatchObject({ login: null, anthropic: false })
    expect(plan.sandbox?.readOnly).toContain(path.dirname(PROGRAM))
    expect(plan.sandbox?.codex).toBeDefined()
  })
})
