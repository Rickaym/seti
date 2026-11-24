import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { claudeDefaults } from './claude-status.js'
import { programVersion } from './program-version.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-claude-status-'))
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const file = (name: string, text: string, mode = 0o644) => {
  const at = path.join(dir, name)
  fs.writeFileSync(at, text, { mode })
  return at
}

describe("Claude Code's status", () => {
  it("reads the default model and effort Claude Code's settings name, and none from a broken file", () => {
    expect(claudeDefaults(file('a.json', '{"model":"opus","effortLevel":"high","env":{"K":"v"}}'))).toEqual({
      default_model: 'opus',
      default_effort: 'high',
    })
    expect(claudeDefaults(file('b.json', '{"model":7}'))).toEqual({ default_model: null, default_effort: null })
    expect(claudeDefaults(file('c.json', 'not json'))).toEqual({ default_model: null, default_effort: null })
    expect(claudeDefaults(path.join(dir, 'missing.json'))).toEqual({ default_model: null, default_effort: null })
  })

  it('reads the version a program reports once per change, and none for a missing program', async () => {
    const program = file('claude', '#!/bin/sh\necho "2.3.1 (Claude Code)"\n', 0o755)
    expect(await programVersion(program)).toBe('2.3.1')
    expect(await programVersion(path.join(dir, 'none'))).toBeNull()
    fs.writeFileSync(program, '#!/bin/sh\necho "codex-cli 0.171.0"\n')
    expect(await programVersion(program)).toBe('0.171.0')
  })
})
