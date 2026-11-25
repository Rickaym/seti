import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.js'
import { claudeRules } from '../../approval-ceiling.js'
import { tasks } from '../../db.js'
import { watchFolderSettings } from '../../folder-settings-trust.js'
import { setupAnswers } from '../../session-setup.js'
import { sessionOptions, setupKey } from '../../session-spec.js'
import { auditEvents } from '../../store/audit.js'
import { folderSettingsWatch } from '../../store/folder-settings.js'
import { folderConfigHook } from './config-hook.js'
import { folderSettingsOf, holdsNothing } from './folder-settings.js'

createApp()

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-folder-settings-'))

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

async function agentIn(name: string, sandbox = true) {
  const cwd = path.join(root, name)
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true })
  await tasks.insert({ id: `folder-${name}`, title: name, repo_id: null, cwd, worktree: false, sandbox, pr_urls: [] })
  const task = await tasks.get(`folder-${name}`)
  if (task === undefined) {
    throw new Error('Task was not stored')
  }
  return task
}

const write = (file: string, value: unknown) => {
  fs.writeFileSync(file, JSON.stringify(value))
}

describe("a Claude Code agent's folder settings", () => {
  it('loads them as they are while no agent session could have written them', async () => {
    const task = await agentIn('kept')
    write(path.join(task.cwd, '.claude', 'settings.local.json'), { permissions: { allow: ['Read'] } })
    await watchFolderSettings(task)
    const settings = await folderSettingsOf(task.cwd)
    expect(settings).toEqual({ local: true, rules: { ask: [], deny: [] }, disabledServers: [] })
    expect(holdsNothing(settings)).toBe(true)
  })

  it('holds back what appeared while a session could write it: allow rules asked, servers off', async () => {
    const task = await agentIn('held')
    await watchFolderSettings(task)
    write(path.join(task.cwd, '.claude', 'settings.json'), { permissions: { allow: ['mcp__docs__read'] } })
    write(path.join(task.cwd, '.claude', 'settings.local.json'), {
      permissions: { allow: ['Bash(curl:*)'], ask: ['Bash(git push:*)'], deny: ['Bash(rm:*)'] },
    })
    write(path.join(task.cwd, '.mcp.json'), { mcpServers: { docs: { command: 'docs' } } })
    const settings = await folderSettingsOf(task.cwd)
    expect(settings).toEqual({
      local: false,
      rules: { ask: ['mcp__docs__read', 'Bash(git push:*)'], deny: ['Bash(rm:*)'] },
      disabledServers: ['docs'],
    })
    expect(holdsNothing(settings)).toBe(false)
    await watchFolderSettings(task)
    expect(await auditEvents.latest('task.folder_settings_held')).toMatchObject({ subject_id: task.id })
    expect((await folderSettingsOf(task.cwd)).disabledServers).toEqual(['docs'])
    write(path.join(task.cwd, '.mcp.json'), { mcpServers: { docs: { command: 'docs', args: ['--mine'] } } })
    await watchFolderSettings(task)
    expect((await folderSettingsOf(task.cwd)).disabledServers).toEqual([])
  })

  it('starts Claude Code without held local settings, their rules passed as its own, at a new key', async () => {
    const task = await agentIn('options', false)
    await watchFolderSettings(task)
    const before = await setupKey(task)
    write(path.join(task.cwd, '.claude', 'settings.local.json'), {
      permissions: { allow: ['Bash(curl:*)'], deny: ['Bash(rm:*)'] },
    })
    const options = await sessionOptions(task, new AbortController())
    expect(options.settingSources).toEqual(['user', 'project'])
    const permissions = (options.settings as { permissions: { deny: string[]; allow: string[] } }).permissions
    expect(permissions.deny).toContain('Bash(rm:*)')
    expect(permissions.allow).not.toContain('Bash(curl:*)')
    expect(await setupKey(task)).not.toBe(before)
    expect((await claudeRules(task)).deny, 'the rules a running session is handed again').toContain('Bash(rm:*)')
  })

  it("starts watching a sandboxed agent's missing settings when its session starts, and not an unsandboxed one's", async () => {
    const boxed = await agentIn('boxed')
    const open = await agentIn('open', false)
    await setupAnswers['session.spec'](boxed.id)
    await setupAnswers['session.spec'](open.id)
    expect(await folderSettingsWatch.of([path.join(boxed.cwd, '.mcp.json')])).toHaveLength(1)
    expect(await folderSettingsWatch.of([path.join(open.cwd, '.mcp.json')])).toEqual([])
  })

  it("blocks a change to the folder's project or local settings mid-session, and nothing else", async () => {
    const [hook] = folderConfigHook.hooks
    const change = (source: string) =>
      ({ hook_event_name: 'ConfigChange', source, session_id: 's', transcript_path: '', cwd: '' }) as HookInput
    const options = { signal: new AbortController().signal }
    expect(await hook?.(change('project_settings'), undefined, options)).toMatchObject({ decision: 'block' })
    expect(await hook?.(change('local_settings'), undefined, options)).toMatchObject({ decision: 'block' })
    expect(await hook?.(change('user_settings'), undefined, options)).toEqual({})
  })
})
