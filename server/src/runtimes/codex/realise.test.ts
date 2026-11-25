import { describe, expect, it } from 'vitest'
import type { Launcher } from '../../launcher.js'
import type { SessionSpec } from '../../session-spec.js'
import { realiseCodex } from './realise.js'

const toolServers = { shared: [], borrowed: { names: [], digest: '' }, signedIn: [], tokens: [] }
const spec = {
  runtime: 'codex',
  cwd: '/work/project',
  resume: null,
  toolServers,
  instructions: { append: '' },
  vendor: { binary: '/c', model: null, effort: null },
} as unknown as SessionSpec<'codex'>
const spawn: NonNullable<Launcher['spawn']> = () => {
  throw new Error('not started in this test')
}
const answering = {
  decide: async () => Promise.reject(new Error('no ask')),
  toolServers: {},
  abortController: new AbortController(),
}
const settingsOf = (args: string[]) => args.filter((_arg, index) => args[index - 1] === '-c')
const launcher = (env: Record<string, string>): Launcher => ({ sandboxed: true, env, spawn })

describe('realising a Codex session', () => {
  it("sends model calls to OpenAI's API with the key's placeholder, and offers no subagents", () => {
    const realised = realiseCodex(spec, launcher({ SETI_MODEL_KEY: 'seti-placeholder' }), {
      ...answering,
      binary: '/c',
    })
    const settings = realised.args.filter((_arg, index) => realised.args[index - 1] === '-c')
    expect(settings).toEqual(
      expect.arrayContaining([
        'model_providers.seti-openai.base_url="https://api.openai.com/v1"',
        'model_providers.seti-openai.env_key="SETI_MODEL_KEY"',
        'features.multi_agent=false',
        'features.multi_agent_v2=false',
      ]),
    )
  })

  it('pins on the command line what a file the agent writes could otherwise change', () => {
    const realised = realiseCodex(spec, launcher({ SETI_MODEL_KEY: 'seti-placeholder', PATH: '/usr/bin:/bin' }), {
      ...answering,
      binary: '/c',
    })
    const settings = realised.args.filter((_arg, index) => realised.args[index - 1] === '-c')
    expect(settings).toEqual(
      expect.arrayContaining([
        'features.unified_exec_tty=false',
        'features.hooks=false',
        'features.goals=false',
        'features.memories=false',
        'features.shell_snapshot=false',
        'skills.include_instructions=false',
        'approvals_reviewer="user"',
        'shell_environment_policy.set.PATH="/usr/bin:/bin"',
      ]),
    )
  })

  it("asks the model for a summary of its reasoning, so the agent's thinking shows", () => {
    const realised = realiseCodex(spec, launcher({ SETI_MODEL_KEY: 'seti-placeholder' }), {
      ...answering,
      binary: '/c',
    })
    expect(settingsOf(realised.args)).toContain('model_reasoning_summary="auto"')
  })

  it("reads a folder's CLAUDE.md when it has no AGENTS.md, as a Claude Code agent reads it", () => {
    const realised = realiseCodex(spec, launcher({ SETI_MODEL_KEY: 'seti-placeholder' }), {
      ...answering,
      binary: '/c',
    })
    expect(settingsOf(realised.args)).toContain('project_doc_fallback_filenames=["CLAUDE.md"]')
  })

  it("starts Seti's tool servers through their relay, and the shared tools with the agent's variables", () => {
    const relay = { command: '/usr/bin/socat', args: ['STDIO', 'UNIX-CONNECT:/run/seti/tools-0.sock'] }
    const withShared = { ...spec, toolServers: { ...toolServers, shared: ['/tools/a'] } }
    const env = { SETI_MODEL_KEY: 'seti-placeholder', GH_TOKEN: 'seti-sandbox-placeholder' }
    const realised = realiseCodex(withShared, launcher(env), {
      ...answering,
      toolServers: { seti: relay },
      binary: '/c',
    })
    const settings = settingsOf(realised.args)
    expect(settings).toEqual(
      expect.arrayContaining([
        'mcp_servers.seti.command="/usr/bin/socat"',
        'mcp_servers.seti.args=["STDIO","UNIX-CONNECT:/run/seti/tools-0.sock"]',
        'mcp_servers.seti.tool_timeout_sec=604800',
        `mcp_servers.shared.command=${JSON.stringify(process.execPath)}`,
        'mcp_servers.shared.env_vars=["GH_TOKEN"]',
      ]),
    )
    expect(settings.filter((setting) => setting.startsWith('mcp_servers.seti.env_vars'))).toEqual([])
  })

  it('refuses a tool server whose name Codex would read as more than one key', () => {
    const relay = { command: '/usr/bin/socat', args: [] }
    const env = { SETI_MODEL_KEY: 'seti-placeholder' }
    const servers = { 'a.b': relay }
    expect(() => realiseCodex(spec, launcher(env), { ...answering, toolServers: servers, binary: '/c' })).toThrow(
      /tool server named "a.b"/,
    )
  })

  it('refuses an agent without an OpenAI key', () => {
    expect(() => realiseCodex(spec, launcher({}), { ...answering, binary: '/c' })).toThrow(/no OpenAI key/)
  })
})
