import { describe, expect, it } from 'vitest'
import {
  commandSummary,
  durationOf,
  exitCode,
  groupLabel,
  kindTallies,
  startsBackground,
  tallyTitle,
  toolName,
  toolSummary,
} from '@/lib/tool-summary'
import type { ToolUseBlock } from '@/lib/transcript'

const call = (name: string, input: Record<string, unknown>): ToolUseBlock => ({
  type: 'tool_use',
  id: `toolu_${name}`,
  name,
  input,
})

describe('commandSummary', () => {
  it('keeps a one-line command as it is', () => {
    expect(commandSummary('git log --oneline -3')).toBe('git log --oneline -3')
  })

  it('skips cd prefixes, chained or on their own line', () => {
    expect(commandSummary('cd /srv/app && git status --short')).toBe('git status --short')
    expect(commandSummary('cd "/srv/my app"; cd sub && npm test')).toBe('npm test')
    expect(commandSummary('cd /srv/app\nnpm run build')).toBe('npm run build')
  })

  it('skips env assignments, exports and set lines', () => {
    expect(commandSummary('IMAGE_TAG=v42 REGION="eu central" ./push.sh --tag "$IMAGE_TAG"')).toBe(
      './push.sh --tag "$IMAGE_TAG"',
    )
    expect(commandSummary('PATH=/opt/node/bin:$PATH pnpm build')).toBe('pnpm build')
    expect(commandSummary('set -euo pipefail\nexport TOKEN=$(cat key)\nnext=$(date) && curl -s api')).toBe(
      'curl -s api',
    )
  })

  it('shows the line that opens a heredoc and skips its body', () => {
    const command = "cat > /tmp/values.yaml <<'EOF'\nkey: value\nother: 1\nEOF\nhelm lint /tmp/values.yaml"
    expect(commandSummary(command)).toBe("cat > /tmp/values.yaml <<'EOF'")
    expect(commandSummary(`# write it\n\n${command}`)).toBe("cat > /tmp/values.yaml <<'EOF'")
  })

  it('looks past a heredoc body when the opening line is only setup', () => {
    expect(commandSummary('TOKEN=$(cat <<\'EOF\'\nsecret body\nEOF\n)\ncurl -H "$TOKEN" api')).toBe(
      'curl -H "$TOKEN" api',
    )
    expect(commandSummary('python3 - <<<"print(1)"')).toBe('python3 - <<<"print(1)"')
  })

  it('drops a trailing line continuation and folds whitespace', () => {
    expect(commandSummary('docker run   --rm \\\n  -v x:y image')).toBe('docker run --rm')
  })

  it('falls back to the first line when nothing else is left', () => {
    expect(commandSummary('cd /srv/app')).toBe('cd /srv/app')
    expect(commandSummary('\n  \n')).toBe('')
  })

  it('caps very long lines', () => {
    expect(commandSummary(`echo ${'x'.repeat(500)}`)).toHaveLength(243)
  })

  it('keeps a cd or assignment followed by something other than && or ; quick to read', () => {
    const dir = `/home/user/.seti/worktrees/${'dashboard-'.repeat(8)}`
    const started = performance.now()
    expect(commandSummary(`cd ${dir} 2>/dev/null && git status`)).toBe(`cd ${dir} 2>/dev/null && git status`)
    expect(commandSummary(`cd ${dir} || exit 1`)).toBe(`cd ${dir} || exit 1`)
    expect(commandSummary(`DIR=${dir}|tee log`)).toBe(`DIR=${dir}|tee log`)
    expect(commandSummary(`cd ${dir}$(pwd)$ && ls`)).toBe('ls')
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('toolSummary', () => {
  it('prefers a Bash description over the command', () => {
    expect(toolSummary(call('Bash', { command: 'kubectl get pods', description: 'List pods' }))).toBe('List pods')
    expect(toolSummary(call('Bash', { command: 'cd /x && kubectl get pods' }))).toBe('kubectl get pods')
  })

  it('names the file, pattern, url or query of other tools', () => {
    expect(toolSummary(call('Read', { file_path: '/srv/a.ts' }))).toBe('/srv/a.ts')
    expect(toolSummary(call('Grep', { pattern: 'TODO', path: 'src' }))).toBe('TODO in src')
    expect(toolSummary(call('WebFetch', { url: 'https://example.com' }))).toBe('https://example.com')
    expect(toolSummary(call('Monitor', { command: 'tail -f log', description: 'Watch the log' }))).toBe('Watch the log')
  })

  it("says what a todo tool call did to the agent's list", () => {
    const todos = [
      { content: 'Read', status: 'completed', activeForm: 'Reading' },
      { content: 'Fix', status: 'in_progress', activeForm: 'Fixing' },
    ]
    expect(toolSummary(call('TodoWrite', { todos }))).toBe('2 items, 1 done')
    expect(toolSummary(call('TaskCreate', { subject: 'Run tests', description: 'All of them' }))).toBe('Run tests')
    expect(toolSummary(call('TaskUpdate', { taskId: '3', status: 'in_progress' }))).toBe('#3 in progress')
    expect(toolSummary(call('TaskUpdate', { taskId: '3', subject: 'Run e2e' }))).toBe('#3 Run e2e')
    expect(toolSummary(call('TaskGet', { taskId: '3' }))).toBe('#3 read')
    expect(toolSummary(call('TaskList', {}))).toBe('list')
    expect(groupLabel(['TaskUpdate', 'TaskUpdate', 'Bash'])).toBe('Updated the todo list 2 times, ran 1 command')
  })

  it('uses the first text input of MCP and unknown tools', () => {
    expect(toolSummary(call('mcp__clickup__clickup_get_task', { task_id: 'abc', limit: 3 }))).toBe('abc')
    expect(toolSummary(call('Custom', { limit: 3 }))).toBe('{"limit":3}')
  })
})

describe('toolName', () => {
  it('splits MCP tools into server and tool', () => {
    expect(toolName('mcp__plugin_slack_slack__slack_read_thread')).toEqual({
      name: 'slack_read_thread',
      server: 'plugin_slack_slack',
    })
    expect(toolName('Bash')).toEqual({ name: 'Bash', server: null })
  })
})

describe('groupLabel', () => {
  it('counts calls by kind in order of first use', () => {
    expect(groupLabel(['Bash', 'Bash', 'Read', 'Bash', 'Read'])).toBe('Ran 3 commands, read 2 files')
    expect(groupLabel(['Read', 'Bash'])).toBe('Read 1 file, ran 1 command')
    expect(groupLabel(['Edit', 'Grep', 'mcp__x__y', 'Skill'])).toBe(
      'Edited 1 file, ran 1 search, made 1 MCP call, used 1 tool',
    )
  })
})

describe('kindTallies', () => {
  const calls = (...specs: [string, boolean][]) => specs.map(([name, failed]) => ({ name, failed }))

  it('keeps one tally per kind in order of first use', () => {
    const tallies = kindTallies(
      calls(['Bash', false], ['Read', false], ['Bash', true], ['mcp__seti__list', false], ['Bash', false]),
    )
    expect(tallies.map((tally) => tally.kind)).toEqual(['command', 'read', 'mcp'])
    expect(tallies[0]).toEqual({ kind: 'command', names: ['Bash'], count: 3, failed: 1 })
    expect(tallies[2]).toEqual({ kind: 'mcp', names: ['list'], count: 1, failed: 0 })
  })

  it('names every tool of a kind once in its hover text', () => {
    const [search, command] = kindTallies(
      calls(['Grep', false], ['Glob', false], ['Grep', false], ['Bash', true], ['Bash', false]),
    )
    expect(search && tallyTitle(search)).toBe('Grep, Glob: 3')
    expect(command && tallyTitle(command)).toBe('Bash: 2, 1 failed')
  })
})

describe('call details', () => {
  it('reads the exit code of a failed shell call', () => {
    expect(exitCode('Exit code 2\nverify failed')).toBe(2)
    expect(exitCode('permission denied')).toBeNull()
  })

  it('reports a duration from a second up', () => {
    expect(durationOf('2026-10-02T10:00:00.000Z', '2026-10-02T10:00:00.400Z')).toBeNull()
    expect(durationOf('2026-10-02T10:00:00.000Z', '2026-10-02T10:01:04.000Z')).toBe('1m 04s')
    expect(durationOf('2026-10-02T10:00:00.000Z', undefined)).toBeNull()
  })

  it('knows the calls that leave a process running', () => {
    expect(startsBackground(call('Monitor', { command: 'x' }))).toBe(true)
    expect(startsBackground(call('Bash', { command: 'x', run_in_background: true }))).toBe(true)
    expect(startsBackground(call('Bash', { command: 'x' }))).toBe(false)
  })
})
