import type { MessageBody, MessageRow } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { displayCommand, ShellIndex } from './background-shells.js'
import {
  backgroundChanged,
  backgroundResult,
  movedResult,
  outputFile,
  plainResult,
  shellCall,
  shellNotification,
  shellStarted,
  shellUpdated,
} from './shell-fixtures.js'

const START = Date.parse('2026-10-01T09:10:00.000Z')

function rowsFrom(first: number, bodies: MessageBody[]): MessageRow[] {
  return bodies.map((body, index) => ({
    ...body,
    id: first + index,
    task_id: 'task',
    outward: [],
    created_at: new Date(START + (first + index - 1) * 1000).toISOString(),
  }))
}

const rows = (...bodies: MessageBody[]) => rowsFrom(1, bodies)

function indexOf(...bodies: MessageBody[]): ShellIndex {
  const index = new ShellIndex()
  for (const row of rows(...bodies)) {
    index.apply(row)
  }
  return index
}

const SEND = 'uv run --quiet python /tmp/send_tests.py'

describe('ShellIndex', () => {
  it('follows a Bash command run in the background to its exit code and output file', () => {
    const index = indexOf(
      shellCall('toolu_send', { command: SEND, description: 'Send test emails', run_in_background: true }),
      backgroundChanged(['bgc1atlt7', 'Send test emails']),
      shellStarted({
        shellId: 'bgc1atlt7',
        toolUseId: 'toolu_send',
        description: 'Send test emails',
        background: true,
      }),
      backgroundResult('toolu_send', 'bgc1atlt7'),
    )
    expect(index.shells(1)).toEqual([
      expect.objectContaining({
        id: 'bgc1atlt7',
        tool: 'Bash',
        command: SEND,
        description: 'Send test emails',
        status: 'running',
        exit_code: null,
        subagent: false,
        has_output: true,
        output_file: outputFile('bgc1atlt7'),
        started_at: '2026-10-01T09:10:02.000Z',
      }),
    ])
    expect(index.runningCommands(1)).toEqual(new Map([['bgc1atlt7', SEND]]))
    expect(index.shells(null)[0]?.status).toBe('killed')

    for (const row of rowsFrom(5, [
      shellUpdated('bgc1atlt7', { status: 'completed', end_time: Date.parse('2026-10-01T09:10:08.592Z') }),
      shellNotification('bgc1atlt7', 'completed', 'Background command "Send" completed (exit code 0)'),
    ])) {
      index.apply(row)
    }
    expect(index.shells(1)[0]).toMatchObject({
      status: 'completed',
      exit_code: 0,
      ended_at: '2026-10-01T09:10:08.592Z',
    })
    expect(index.runningCommands(1).size).toBe(0)
  })

  it('keeps a foreground command once a timeout moves it to the background, and drops plain ones', () => {
    const index = indexOf(
      shellCall('toolu_fg', { command: 'pnpm test', description: 'Run tests' }),
      shellStarted({ shellId: 'bfg', toolUseId: 'toolu_fg', description: 'Run tests', background: false }),
      plainResult('toolu_fg', 'ok'),
      shellNotification('bfg', 'completed', 'Run tests', ''),
      shellCall('toolu_pull', { command: 'python3 pull.py', description: 'Pull generations' }),
      shellStarted({
        shellId: 'btu0s489u',
        toolUseId: 'toolu_pull',
        description: 'Pull generations',
        background: false,
      }),
      backgroundChanged(['btu0s489u', 'Pull generations']),
      shellUpdated('btu0s489u', { is_backgrounded: true }),
      movedResult('toolu_pull', 'btu0s489u'),
      shellUpdated('btu0s489u', { status: 'failed', end_time: Date.parse('2026-10-01T10:42:50.581Z') }),
      shellNotification('btu0s489u', 'failed', 'Background command "Pull" failed (exit code 2)'),
    )
    expect(index.shells(1).map((shell) => [shell.id, shell.status, shell.exit_code])).toEqual([
      ['btu0s489u', 'failed', 2],
    ])
    expect(index.shells(1)[0]?.has_output).toBe(true)
  })

  it('marks a subagent shell stopped with TaskStop as killed', () => {
    const index = indexOf(
      shellCall('toolu_dev', { command: 'npx next dev -p 3001', run_in_background: true }, 'Bash', 'toolu_agent'),
      shellStarted({
        shellId: 'byo8w3tbn',
        toolUseId: 'toolu_dev',
        description: 'Dev server',
        background: true,
        subagent: true,
      }),
      backgroundResult('toolu_dev', 'byo8w3tbn'),
      shellUpdated('byo8w3tbn', { status: 'killed', end_time: Date.parse('2026-10-01T09:34:47.693Z') }),
      shellNotification('byo8w3tbn', 'stopped', 'Dev server'),
    )
    expect(index.shells(1)).toEqual([
      expect.objectContaining({ id: 'byo8w3tbn', status: 'killed', subagent: true, exit_code: null }),
    ])
  })

  it('names the cause when Claude Code stops a shell at its time limit or on low memory', () => {
    const started = (id: string) => [
      shellCall(`toolu_${id}`, { command: `npm run watch # ${id}`, run_in_background: true }),
      shellStarted({ shellId: id, toolUseId: `toolu_${id}`, description: 'Watch', background: true }),
      backgroundResult(`toolu_${id}`, id),
    ]
    const stopped = (id: string, why: string) =>
      shellNotification(id, 'stopped', `Background command "Watch" was stopped${why}`)
    const index = indexOf(
      ...started('blimit'),
      shellUpdated('blimit', { status: 'killed', end_time: Date.parse('2026-10-03T10:30:00.000Z') }),
      stopped('blimit', ' after reaching its background time limit'),
      ...started('bmem'),
      stopped('bmem', ' because the system is running low on memory'),
      ...started('buser'),
      stopped('buser', ''),
    )
    expect(index.shells(1).map((shell) => [shell.id, shell.status, shell.stop_cause])).toEqual([
      ['blimit', 'killed', 'time_limit'],
      ['bmem', 'killed', 'low_memory'],
      ['buser', 'killed', null],
    ])
  })

  it('lists a Monitor watch, which runs as a local_bash task too', () => {
    const watch = 'while true; do sleep 20; done'
    const index = indexOf(
      shellCall('toolu_watch', { command: watch, description: 'bench progress', timeout_ms: 1_800_000 }, 'Monitor'),
      backgroundChanged(['b1tc1wv3z', 'bench progress']),
      shellStarted({ shellId: 'b1tc1wv3z', toolUseId: 'toolu_watch', description: 'bench progress', background: true }),
      plainResult('toolu_watch', 'Monitor started (task b1tc1wv3z, expires in 30m unless the source ends first).'),
    )
    expect(index.shells(2)).toEqual([
      expect.objectContaining({ id: 'b1tc1wv3z', tool: 'Monitor', status: 'running', has_output: false }),
    ])
    expect(index.shells(5)[0]?.status).toBe('killed')
  })

  it('reads a background command that only its tool result reports, as older versions did', () => {
    const index = indexOf(
      shellCall('toolu_old', { command: 'sleep 100', run_in_background: true }),
      backgroundResult('toolu_old', 'bold'),
    )
    expect(index.shells(1)).toEqual([expect.objectContaining({ id: 'bold', command: 'sleep 100', status: 'running' })])
  })

  it('redacts secrets in the command it shows', () => {
    const fake = (...parts: string[]) => parts.join('')
    const AWS_KEY = fake('AKIA', 'ABCDEFGH', 'IJKLMNOP')
    const BEARER = fake('abcdef', 'ghijklmnopqrstuvwxyz0123')
    const GH_TOKEN = fake('ghp', '_', 'abcdefghijklmnopqrstuvwxyz012345')
    const ANT_KEY = fake('sk-ant', '-api03-', 'abcdefghijklmnop')
    const command =
      `curl -H "Authorization: Bearer ${BEARER}" --token=hunter2hunter2 https://x.dev ` +
      `GITHUB=${GH_TOKEN} ${AWS_KEY} ${ANT_KEY}`
    const shown = displayCommand(command)
    for (const secret of ['abcdefghijklmnopqrstuvwxyz0123', 'hunter2', 'ghp_', 'AKIAABCD', 'sk-ant']) {
      expect(shown).not.toContain(secret)
    }
    expect(shown).toContain('curl -H')
    expect(shown).toContain('https://x.dev')
    expect(displayCommand('x'.repeat(5000), 100)).toHaveLength(100)
  })
})
