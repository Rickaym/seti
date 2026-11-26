import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { envFileText, liveVariableText, SANDBOX_ENV_FILE, writeSandboxEnv } from './sandbox-env-file.js'

const PLACEHOLDER = 'seti-secret-api_token-0123456789abcdef0123456789abcdef'

describe("a sandbox's env file", () => {
  it('exports each placeholder under a shell-safe name and leaves out any other name or value', () => {
    expect(
      envFileText({
        API_TOKEN: PLACEHOLDER,
        'BAD-NAME': PLACEHOLDER,
        '1ST': PLACEHOLDER,
        QUOTED: "it's",
        SUBST: '$(id)',
        NEWLINE: 'a\nb',
      }),
    ).toBe(`export API_TOKEN='${PLACEHOLDER}'\n`)
    expect(envFileText({})).toBe('')
  })

  it('replaces the file whole, mode 600, through a rename that leaves no temporary file', () => {
    const run = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-run-'))
    expect(writeSandboxEnv(run, { API_TOKEN: PLACEHOLDER })).toBe(true)
    const file = path.join(run, 'env.sh')
    const before = fs.statSync(file).ino
    expect(writeSandboxEnv(run, {})).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('')
    expect(fs.statSync(file).ino).not.toBe(before)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(run)).toEqual(['env.sh'])
  })

  it('writes nothing in a missing folder or inside a git checkout', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-run-checkout-'))
    fs.mkdirSync(path.join(repo, '.git'))
    fs.mkdirSync(path.join(repo, 'run'))
    expect(writeSandboxEnv(path.join(repo, 'run'), { API_TOKEN: PLACEHOLDER })).toBe(false)
    expect(fs.readdirSync(path.join(repo, 'run'))).toEqual([])
    expect(writeSandboxEnv(path.join(repo, 'missing'), {})).toBe(false)
  })

  it('tells the agent to go on in this turn and where another shell reads the variable', () => {
    const text = liveVariableText('API_TOKEN')
    expect(text).toContain('Your bash commands have $API_TOKEN from now on, so carry on with your work in this turn')
    expect(text).toContain(`a process started before now such as an MCP server, gets it with \`. ${SANDBOX_ENV_FILE}\``)
    expect(SANDBOX_ENV_FILE).toBe('/run/seti/env.sh')
  })
})
