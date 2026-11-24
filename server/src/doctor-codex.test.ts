import fs from 'node:fs'
import path from 'node:path'
import { CODEX_SETTINGS_DEFAULTS, DEFAULT_PROFILE_ID } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { doctorCodex } from './doctor-codex.js'
import { codexSettings } from './store/codex-settings.js'
import { clearConnections, keyConnection } from './test-connections.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-doctor-codex-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

afterAll(async () => {
  await codexSettings.set(CODEX_SETTINGS_DEFAULTS)
  await clearConnections()
})

describe("the doctor's Codex line", () => {
  it('says nothing while Codex is off', async () => {
    await codexSettings.set(CODEX_SETTINGS_DEFAULTS)
    expect(await doctorCodex()).toEqual([])
  })

  it("names the missing copy and key with fixes in Settings, then the user's program and key", async () => {
    await clearConnections()
    await codexSettings.set({ ...CODEX_SETTINGS_DEFAULTS, enabled: true })
    const bare = await doctorCodex()
    expect(bare.map((check) => [check.state, check.fix])).toEqual([
      ['warn', 'Settings, Runtimes: Retry'],
      ['warn', 'Settings, Connections: add your OpenAI key connection to the default credential'],
    ])
    const own = path.join(scratch, 'codex')
    fs.writeFileSync(own, '#!/bin/sh\necho "codex-cli 0.171.0"\n', { mode: 0o755 })
    await codexSettings.set({ ...CODEX_SETTINGS_DEFAULTS, enabled: true, program: own })
    await keyConnection('doctor_openai', 'not-a-key', {
      hosts: ['api.openai.com'],
      header: { name: 'Authorization', template: 'Bearer {{value}}' },
      profile_ids: [DEFAULT_PROFILE_ID],
    })
    const ready = await doctorCodex()
    expect(ready.map((check) => check.state)).toEqual(['ok', 'ok'])
    expect(ready[0]?.label).toContain(own)
  })
})
