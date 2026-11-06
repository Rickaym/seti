import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { claudeOnPath, findClaudeBin } from './claude-bin.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-claude-bin-'))
const broken = path.join(root, 'broken')
const working = path.join(root, 'working')
fs.mkdirSync(broken)
fs.mkdirSync(working)
fs.symlinkSync(path.join(root, 'versions', 'gone'), path.join(broken, 'claude'))
fs.writeFileSync(path.join(working, 'claude'), '#!/bin/sh\n', { mode: 0o755 })

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('findClaudeBin', () => {
  it('skips a claude on PATH whose link target is gone', () => {
    expect(claudeOnPath(`${broken}:${working}`)).toBe(path.join(working, 'claude'))
    expect(claudeOnPath(broken)).toBeNull()
  })

  it("prefers the configured binary, then PATH, then the Agent SDK's own", () => {
    expect(findClaudeBin('/opt/claude', working)).toBe('/opt/claude')
    expect(findClaudeBin(undefined, working)).toBe(path.join(working, 'claude'))
    const bundled = findClaudeBin(undefined, broken)
    expect(bundled).toMatch(/claude-agent-sdk-[\w-]+\/claude(\.exe)?$/)
    expect(fs.existsSync(bundled)).toBe(true)
  })
})
