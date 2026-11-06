import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CapabilitiesSnapshot, CommandInfo } from '@seti/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { commandCatalog, MENU_DESCRIPTION_LIMIT, menuDescription, nearbyDirs } from './commands.js'

const LONG =
  '(acme) Review and improve WRITTEN MATERIAL of any kind, section by section: diagram labels, documents, ' +
  'reports, Slack messages, commit messages, voice-assistant prompts, SKILL.md files and CLAUDE.md ' +
  'playbooks. Use when asked to tighten, rewrite or proofread text before it goes out.\n\nTriggers on: ' +
  '"improve this", "rewrite", "proofread".'

const info = (name: string, description = LONG): CommandInfo => ({
  name,
  description,
  argument_hint: '[target]',
  aliases: [],
})

function snapshot(skills: number): CapabilitiesSnapshot {
  return {
    cwd: '/repo',
    probed_at: '2026-09-30T10:00:00.000Z',
    duration_ms: 1,
    pending_timed_out: false,
    account: { email: null, organization: null, subscription_type: null, api_provider: null },
    servers: [],
    skill_groups: [
      { prefix: 'posthog', commands: Array.from({ length: skills }, (_, i) => info(`posthog:skill-${String(i)}`)) },
    ],
    builtin_commands: [info('compact', 'Free up context'), info('color', 'Set the prompt bar color')],
    subagents: [],
    models: [],
  }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-command-catalog-test-'))

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('menuDescription', () => {
  it('keeps short text and cuts long text to one row at a word boundary', () => {
    expect(menuDescription('  Free up\n context ')).toBe('Free up context')
    const cut = menuDescription(LONG)
    expect(cut.length).toBeLessThanOrEqual(MENU_DESCRIPTION_LIMIT)
    expect(cut).toMatch(/^\(acme\) Review and improve WRITTEN MATERIAL/)
    expect(cut).toMatch(/\w\.\.\.$/)
    expect(cut).not.toContain('\n')
  })
})

describe('commandCatalog', () => {
  it('sends only what the menu shows and says whether the list is exact and fresh', () => {
    const catalog = commandCatalog({ snapshot: snapshot(2), exact: false, fresh: false })
    expect(catalog).toMatchObject({ cwd: '/repo', fresh: false, approximate: true })
    expect(catalog.commands.map((command) => Object.keys(command).sort((a, b) => a.localeCompare(b)))).toEqual(
      Array.from({ length: 4 }, () => ['aliases', 'argument_hint', 'builtin', 'description', 'name', 'unsupported']),
    )
    expect(catalog.commands.find((command) => command.name === 'color')?.unsupported).not.toBeNull()
  })

  it('keeps a catalog of 330 long-described commands under 80 KB', () => {
    const catalog = commandCatalog({ snapshot: snapshot(328), exact: true, fresh: true })
    expect(catalog.commands).toHaveLength(330)
    const full = JSON.stringify(snapshot(328).skill_groups).length
    const sent = JSON.stringify(catalog).length
    expect(full).toBeGreaterThan(130_000)
    expect(sent).toBeLessThan(80_000)
    expect(Math.max(...catalog.commands.map((command) => command.description.length))).toBeLessThanOrEqual(
      MENU_DESCRIPTION_LIMIT,
    )
  })
})

describe('nearbyDirs', () => {
  const git = (cwd: string, ...args: string[]) =>
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like git.ts
    execFileSync('git', ['-c', 'user.name=Seti Test', '-c', 'user.email=test@seti.invalid', '-C', cwd, ...args], {
      stdio: 'pipe',
    })

  it('names the main checkout of a worktree before home, and only home elsewhere', async () => {
    const main = path.join(scratch, 'main')
    const worktree = path.join(scratch, 'main-worktree')
    const plain = path.join(scratch, 'plain')
    fs.mkdirSync(main)
    fs.mkdirSync(plain)
    git(main, 'init', '--initial-branch=main')
    git(main, 'commit', '--allow-empty', '-m', 'chore: seed')
    git(main, 'worktree', 'add', '--detach', worktree)

    expect(await nearbyDirs(worktree)).toEqual([fs.realpathSync(main), os.homedir()])
    expect(await nearbyDirs(main)).toEqual([os.homedir()])
    expect(await nearbyDirs(plain)).toEqual([os.homedir()])
  })
})
