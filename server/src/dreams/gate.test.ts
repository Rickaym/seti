import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { claudeToolCall, type DreamReport } from '@seti/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { denialKind, dreamGate, type DreamPlaces } from './gate.js'
import { dreamTools } from './tools.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seti-dream-gate-')))
const cwd = path.join(root, 'work')
const memory = path.join(root, 'home', '.claude', 'projects', 'work', 'memory')
const night = path.join(root, 'workspace', 'dreams', '2026-11-23')
for (const dir of [cwd, memory, night]) {
  fs.mkdirSync(dir, { recursive: true })
}
fs.writeFileSync(path.join(memory, 'MEMORY.md'), '- one\n')
fs.writeFileSync(path.join(memory, 'blob.bin'), Buffer.from([0, 1, 2]))

const places: DreamPlaces = {
  cwd,
  home: path.join(root, 'home'),
  readable: [cwd, memory, path.dirname(path.dirname(night))],
  memory,
  night,
}

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const gate = (name: string, input: Record<string, unknown>) =>
  dreamGate(claudeToolCall('call', name, input), places, memory)

const TOKEN = `ghp_${'Z9y8'.repeat(9)}`

describe('dreamGate', () => {
  it('allows reading and searching anywhere the sandbox shows', () => {
    expect(gate('Read', { file_path: '/etc/hostname' })).toBeNull()
    expect(gate('Grep', { pattern: 'x', path: cwd })).toBeNull()
    expect(gate('Glob', { pattern: '**/*.md' })).toBeNull()
  })

  it('allows writes to the memory and night folders only', () => {
    expect(gate('Write', { file_path: path.join(memory, 'topics', 'git.md'), content: '- rebase first\n' })).toBeNull()
    expect(gate('Edit', { file_path: path.join(memory, 'MEMORY.md'), old_string: 'one', new_string: 'two' })).toBeNull()
    expect(gate('Write', { file_path: path.join(night, 'notes.md'), content: 'x' })).toBeNull()
    expect(gate('Write', { file_path: path.join(cwd, 'README.md'), content: 'x' })).toMatch(/only its memory folder/)
    expect(gate('Write', { file_path: path.join(memory, '..', 'x.jsonl'), content: 'x' })).toMatch(/only its memory/)
    expect(gate('Write', { file_path: path.join(memory, '.consolidate-lock'), content: '1' })).toMatch(/hidden/)
    expect(gate('Write', { file_path: path.join(memory, 'blob.bin'), content: 'x' })).toMatch(/not text/)
  })

  it('refuses a write that carries a credential, in Write, Edit and MultiEdit', () => {
    const file = path.join(memory, 'MEMORY.md')
    expect(gate('Write', { file_path: file, content: `- token ${TOKEN}` })).toMatch(/credential/)
    expect(gate('Edit', { file_path: file, old_string: 'one', new_string: TOKEN })).toMatch(/credential/)
    const edits = [
      { old_string: 'one', new_string: 'two' },
      { old_string: 'two', new_string: TOKEN },
    ]
    expect(gate('MultiEdit', { file_path: file, edits })).toMatch(/credential/)
  })

  it('refuses a write that takes the memory folder past its limit', () => {
    const big = 'x'.repeat(600 * 1024)
    expect(gate('Write', { file_path: path.join(memory, 'big.md'), content: big })).toMatch(/limit/)
  })

  it('runs only shell lines that read', () => {
    expect(gate('Bash', { command: `ls -la ${cwd}` })).toBeNull()
    expect(gate('Bash', { command: 'git status' })).toBeNull()
    expect(gate('Bash', { command: `git -C ${cwd} log --oneline -5` })).toBeNull()
    expect(gate('Bash', { command: 'git worktree list --porcelain' })).toBeNull()
    expect(gate('Bash', { command: 'git branch --list -vv' })).toBeNull()
    for (const command of [
      `rm -rf ${cwd}`,
      'git clean -fdx',
      'git branch -D old',
      'git push',
      `git -C /etc status`,
      `cat ${cwd}/a > ${memory}/b`,
      'curl https://example.com',
      'find . -delete',
      'python3 -c "print(1)"',
    ]) {
      expect(gate('Bash', { command }), command).toMatch(/only commands that read/)
    }
  })

  it('refuses every other tool by name, its own report aside', () => {
    expect(gate('mcp__dream__dream_report', { summary: 'x' })).toBeNull()
    expect(gate('mcp__seti__post_team_chat', {})).toMatch(/no tool servers/)
    for (const name of ['WebFetch', 'WebSearch', 'Agent', 'Task', 'AskUserQuestion', 'TodoWrite', 'NotebookEdit']) {
      expect(gate(name, { url: 'https://example.com', notebook_path: path.join(cwd, 'a.ipynb') }), name).not.toBeNull()
    }
    expect(gate('ToolSearch', { query: 'slack' })).toMatch(/no tools to search/)
  })
})

describe('denialKind', () => {
  it('names the kind of each refusal without its call', () => {
    const big = 'x'.repeat(600 * 1024)
    const refusals: [string | null, string][] = [
      [gate('Bash', { command: `wc -l ${memory}/*.md` }), 'shell'],
      [gate('Bash', { command: `git -C ${cwd} status 2>/dev/null` }), 'shell'],
      [gate('Write', { file_path: path.join(cwd, 'README.md'), content: 'x' }), 'write_outside'],
      [gate('Write', { file_path: path.join(memory, '.consolidate-lock'), content: '1' }), 'hidden'],
      [gate('Write', { file_path: path.join(memory, 'MEMORY.md'), content: TOKEN }), 'credential'],
      [gate('Write', { file_path: path.join(memory, 'blob.bin'), content: 'x' }), 'not_text'],
      [gate('Write', { file_path: path.join(memory, 'big.md'), content: big }), 'memory_limit'],
      [gate('Agent', { prompt: 'x' }), 'tool'],
      [gate('mcp__seti__post_team_chat', {}), 'tool'],
    ]
    for (const [refusal, kind] of refusals) {
      expect(denialKind(refusal ?? ''), kind).toBe(kind)
    }
  })
})

describe('dream_report', () => {
  it('stores the report redacted, and refuses one out of shape', async () => {
    const stored: DreamReport[] = []
    const [tool] = dreamTools(async (report) => {
      stored.push(report)
      return Promise.resolve()
    })
    expect(await tool?.call({ summary: `Tidied memory; key was ${TOKEN}`, tidied: ['Merged two git notes'] })).toMatch(
      /Stored/,
    )
    expect(stored[0]?.summary).not.toContain(TOKEN)
    expect(stored[0]).toMatchObject({ tidied: ['Merged two git notes'], asks: [], nothing_to_do: false })
    expect(await tool?.call({ summary: 'x', asks: ['a', 'b', 'c', 'd'] })).toMatch(/Not stored/)
    expect(stored).toHaveLength(1)
  })
})
