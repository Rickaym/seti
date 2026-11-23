import type { HookCallback, HookInput } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import type { Launcher } from '../../launcher.js'
import type { DreamHost, DreamSpec } from '../adapter.js'
import { claudeAdapter } from './adapter.js'
import { dreamOptions } from './dream.js'

const spec: DreamSpec = {
  taskId: 'task-1',
  cwd: '/work/agent',
  dirs: ['/work/extra'],
  model: 'claude-sonnet-5-5',
  append: 'You are dreaming.',
  prompt: 'Dream for the night of 2026-11-23.',
  maxTurns: 60,
  budgetUsd: 1,
}

const host = (gate: DreamHost['gate']): DreamHost => ({
  gate,
  tools: [
    {
      server: 'dream',
      name: 'dream_report',
      description: 'Report',
      input: {},
      call: async () => Promise.resolve('ok'),
    },
  ],
})

const launcher: Launcher = {
  sandboxed: true,
  env: { HOME: '/home/me', HTTPS_PROXY: 'http://127.0.0.1:3128' },
  spawn: () => {
    throw new Error('A test starts no process')
  },
}

async function decide(hook: HookCallback | undefined, tool: string, input: Record<string, unknown>) {
  const given = {
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: input,
    tool_use_id: 'call-1',
    session_id: 's',
    transcript_path: '',
    cwd: spec.cwd,
  } as HookInput
  return hook?.(given, 'call-1', { signal: new AbortController().signal })
}

describe('a Claude Code dream', () => {
  const options = dreamOptions(
    spec,
    launcher,
    host(() => null),
    new AbortController(),
  )

  it('starts a new session that saves nothing, with only the dream tools and server', () => {
    expect(options).toMatchObject({
      cwd: spec.cwd,
      additionalDirectories: spec.dirs,
      model: 'claude-sonnet-5-5',
      tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
      permissionMode: 'dontAsk',
      strictMcpConfig: true,
      settingSources: [],
      settings: { autoDreamEnabled: false },
      persistSession: false,
      maxTurns: 60,
      maxBudgetUsd: 1,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are dreaming.' },
    })
    expect(options.resume).toBeUndefined()
    expect(options.forkSession).toBeUndefined()
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['dream'])
    expect(options.allowedTools).toContain('mcp__dream__dream_report')
    expect(options.plugins).toBeUndefined()
    expect(options.env).toMatchObject(launcher.env)
  })

  it('lets the gate decide every tool call, and refuses one it cannot check', async () => {
    const refusing = dreamOptions(
      spec,
      launcher,
      host((call) => (call.kind === 'edit' ? 'A dream writes only its memory folder.' : null)),
      new AbortController(),
    )
    const [matcher] = refusing.hooks?.PreToolUse ?? []
    expect(matcher?.matcher).toBeUndefined()
    const hook = matcher?.hooks[0]
    expect(await decide(hook, 'Read', { file_path: '/work/agent/a' })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    })
    expect(await decide(hook, 'Write', { file_path: '/work/agent/a', content: 'x' })).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'A dream writes only its memory folder.',
      },
    })
    const broken = dreamOptions(
      spec,
      launcher,
      host(() => {
        throw new Error('no folder')
      }),
      new AbortController(),
    )
    expect(await decide(broken.hooks?.PreToolUse?.[0]?.hooks[0], 'Read', {})).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    })
  })

  it('is declared by the Claude adapter, with the memory folder of the working folder', () => {
    const dream = claudeAdapter.capabilities.dream
    expect(dream?.memory('/work/agent')).toMatch(/\/projects\/-work-agent\/memory$/)
  })
})
