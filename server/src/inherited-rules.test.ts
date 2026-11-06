import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { projectSettingsRules, settingsRules } from './inherited-rules.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-inherited-'))

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

function write(relative: string, content: string): string {
  const file = path.join(home, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

describe('rules from Claude Code settings files', () => {
  it('reads every behavior with its file, the home directory as ~', () => {
    const file = write(
      '.claude/settings.json',
      JSON.stringify({
        model: 'opus',
        permissions: { allow: ['Bash(aws ssm send-command:*)', 3], deny: ['WebFetch'], defaultMode: 'default' },
      }),
    )
    expect(settingsRules(file, home)).toEqual([
      { behavior: 'allow', rule: 'Bash(aws ssm send-command:*)', source: '~/.claude/settings.json' },
      { behavior: 'deny', rule: 'WebFetch', source: '~/.claude/settings.json' },
    ])
  })

  it('reads a project and its local settings, and none from a missing or broken file', () => {
    write('repo/.claude/settings.json', JSON.stringify({ permissions: { ask: ['Bash(git push:*)'] } }))
    write('repo/.claude/settings.local.json', '{ not json')
    expect(projectSettingsRules(path.join(home, 'repo')).map((rule) => [rule.behavior, rule.rule])).toEqual([
      ['ask', 'Bash(git push:*)'],
    ])
    expect(projectSettingsRules(path.join(home, 'nowhere'))).toEqual([])
  })
})
