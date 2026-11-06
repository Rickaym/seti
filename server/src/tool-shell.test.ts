import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { TOOL_OOM_ADJ } from './oom-guard.js'
import { writeToolShell } from './tool-shell.js'

const run = promisify(execFile)

describe('the tool shell prefix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-tool-shell-'))
  const file = writeToolShell(path.join(dir, 'bin', 'tool-shell'))

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const shellOf = async (env: Record<string, string>) => {
    const command = 'cat /proc/self/oom_score_adj; echo "$0"'
    const { stdout } = await run(file, [command], { env: { PATH: process.env.PATH ?? '', ...env } })
    return stdout.trim().split('\n')
  }

  it("runs the command it is given at the tools' adj, in the shell Claude Code picked", async () => {
    expect(await shellOf({ CLAUDE_CODE_SHELL: '/bin/bash', SHELL: '/bin/sh' })).toEqual([
      String(TOOL_OOM_ADJ),
      '/bin/bash',
    ])
  })

  it('falls back to bash for a shell Claude Code does not run commands in', async () => {
    expect(await shellOf({ SHELL: '/usr/bin/fish' })).toEqual([String(TOOL_OOM_ADJ), '/bin/bash'])
    expect(await shellOf({ CLAUDE_CODE_SHELL: '/nowhere/bash' })).toEqual([String(TOOL_OOM_ADJ), '/bin/bash'])
  })

  it('leaves a current copy alone and replaces a stale one', () => {
    const before = fs.statSync(file)
    writeToolShell(file)
    expect(fs.statSync(file).ino).toBe(before.ino)
    fs.writeFileSync(file, '#!/bin/sh\n')
    writeToolShell(file)
    expect(fs.readFileSync(file, 'utf8')).toContain(`echo ${String(TOOL_OOM_ADJ)} >/proc/self/oom_score_adj`)
    expect(fs.statSync(file).mode & 0o111).toBe(0o111)
  })
})
