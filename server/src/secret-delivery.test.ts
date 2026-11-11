import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitCheckoutAbove, suppliedText, writeSecretFile } from './secret-delivery.js'
import { sandboxContext } from './session-options.js'
import { sandboxPolicy } from './store/sandbox.js'
import { fileRules, pathProblem } from './task-files.js'
import { secretsDir, workspaceDir } from './workspace/dir.js'

const fixtureValue = () => ['fixture', 'value', randomUUID()].join('-')
const modeOf = (file: string) => fs.statSync(file).mode & 0o777

describe('secret files', () => {
  it('writes the value to secrets/<NAME> in the workspace, mode 600 in a folder of mode 700', () => {
    const taskId = `secret-file-${randomUUID()}`
    const value = fixtureValue()
    const file = writeSecretFile(taskId, 'AZURE_SPEECH_KEY', value)
    expect(file).toBe(path.join(workspaceDir(taskId), 'secrets', 'AZURE_SPEECH_KEY'))
    expect(fs.readFileSync(file, 'utf8')).toBe(value)
    expect(modeOf(file)).toBe(0o600)
    expect(modeOf(secretsDir(taskId))).toBe(0o700)
    expect(gitCheckoutAbove(file)).toBeNull()
  })

  it('replaces an earlier value whole, through a renamed file, and leaves no temporary files', () => {
    const taskId = `secret-replace-${randomUUID()}`
    const file = writeSecretFile(taskId, 'API_TOKEN', fixtureValue())
    const before = fs.statSync(file).ino
    fs.chmodSync(secretsDir(taskId), 0o750)
    const next = fixtureValue()
    expect(writeSecretFile(taskId, 'API_TOKEN', next)).toBe(file)
    expect(fs.readFileSync(file, 'utf8')).toBe(next)
    expect(fs.statSync(file).ino).not.toBe(before)
    expect(modeOf(file)).toBe(0o600)
    expect(modeOf(secretsDir(taskId))).toBe(0o700)
    expect(fs.readdirSync(secretsDir(taskId))).toEqual(['API_TOKEN'])
  })

  it('refuses a symlink in place of the secrets folder', () => {
    const taskId = `secret-link-${randomUUID()}`
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-elsewhere-'))
    fs.mkdirSync(workspaceDir(taskId), { recursive: true })
    fs.symlinkSync(elsewhere, secretsDir(taskId))
    expect(() => writeSecretFile(taskId, 'API_TOKEN', fixtureValue())).toThrow(/not a plain folder/)
    expect(fs.readdirSync(elsewhere)).toEqual([])
  })

  it('finds a git checkout above a folder', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-checkout-'))
    fs.mkdirSync(path.join(repo, '.git'))
    fs.mkdirSync(path.join(repo, 'a', 'b'), { recursive: true })
    expect(gitCheckoutAbove(path.join(repo, 'a', 'b'))).toBe(repo)
  })

  it('tells the agent the path or the placeholder, never the value', () => {
    const file = suppliedText({ name: 'API_TOKEN', hosts: [], delivery: 'file' }, '/w/secrets/API_TOKEN')
    expect(file).toMatch(/^The value of API_TOKEN is in \/w\/secrets\/API_TOKEN\. Read it from there/)
    expect(file).toContain('never open it with the Read tool, print it, log it or commit it')
    const stored = suppliedText({ name: 'API_TOKEN', hosts: ['api.example.com'], delivery: 'secret_store' }, null)
    expect(stored).toContain("in Seti's secret store for api.example.com")
  })

  it('never serves the secrets folder in the Files view', async () => {
    const taskId = `secret-files-${randomUUID()}`
    const file = writeSecretFile(taskId, 'API_TOKEN', fixtureValue())
    const rules = fileRules(taskId, await sandboxPolicy.get(), sandboxContext())
    expect(pathProblem(fs.realpathSync(file), rules)).toMatch(/holds secrets/)
    expect(pathProblem(fs.realpathSync(workspaceDir(taskId)), rules)).toBeNull()
  })
})
