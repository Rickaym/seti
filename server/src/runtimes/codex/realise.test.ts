import { describe, expect, it } from 'vitest'
import type { CodexToolServer } from '../../codex-tool-servers.js'
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
  vendor: { binary: '/c', model: null, effort: null, skills: [], servers: [] },
  compaction: { auto: true, window_k: null, threshold_pct: null, instructions: null },
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

  it("lists the user's skills after the instructions, each at its read-only copy in the home", () => {
    const skilled = {
      ...spec,
      vendor: { ...spec.vendor, skills: [{ name: 'pdf', description: 'PDFs', folder: 'pdf' }] },
    }
    const realised = realiseCodex(skilled, launcher({ SETI_MODEL_KEY: 'k', HOME: '/home/agent' }), {
      ...answering,
      binary: '/c',
    })
    expect(realised.instructions).toContain("## The user's skills")
    expect(realised.instructions).toContain('- pdf: PDFs (file: /home/agent/.agents/skills/pdf/SKILL.md)')
    const none = realiseCodex(spec, launcher({ SETI_MODEL_KEY: 'k', HOME: '/home/agent' }), {
      ...answering,
      binary: '/c',
    })
    expect(none.instructions).not.toContain('skills')
  })

  it('compacts at the window and Compact at of the rule, with its instructions, and else where Codex picks', () => {
    const realise = (compaction: object) =>
      settingsOf(
        realiseCodex({ ...spec, compaction } as SessionSpec<'codex'>, launcher({ SETI_MODEL_KEY: 'p' }), {
          ...answering,
          binary: '/c',
        }).args,
      )
    const rule = { auto: true, window_k: 200, threshold_pct: 60, instructions: 'Keep the branch names.' }
    expect(realise(rule)).toEqual(
      expect.arrayContaining([
        'model_auto_compact_token_limit=120000',
        expect.stringMatching(/^compact_prompt=".*Keep the branch names\."$/),
      ]),
    )
    const loose = realise({ ...rule, auto: false, threshold_pct: null, instructions: null })
    expect(
      loose.filter((setting) => setting.startsWith('model_auto_compact') || setting.startsWith('compact_prompt')),
    ).toEqual([])
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

  it("starts the user's servers in the sandbox, asking Seti about every call, never with the key", () => {
    const servers: CodexToolServer[] = [
      { name: 'play', transport: 'stdio', command: 'npx', args: ['@playwright/mcp'] },
      { name: 'docs', transport: 'http', url: 'https://docs.example.com/mcp' },
      { name: 'shared', transport: 'stdio', command: 'not-seti', args: [] },
    ]
    const withServers = { ...spec, vendor: { ...spec.vendor, servers } }
    const env = { SETI_MODEL_KEY: 'seti-placeholder', GH_TOKEN: 'seti-sandbox-placeholder' }
    const realised = realiseCodex(withServers, launcher(env), { ...answering, binary: '/c' })
    const settings = settingsOf(realised.args)
    expect(settings).toEqual(
      expect.arrayContaining([
        'mcp_servers.play.command="npx"',
        'mcp_servers.play.args=["@playwright/mcp"]',
        'mcp_servers.play.env_vars=["GH_TOKEN"]',
        'mcp_servers.play.default_tools_approval_mode="prompt"',
        'mcp_servers.docs.url="https://docs.example.com/mcp"',
        'mcp_servers.docs.default_tools_approval_mode="prompt"',
      ]),
    )
    expect(settings.filter((each) => each.startsWith('mcp_servers.docs.env_vars'))).toEqual([])
    expect(settings.filter((each) => each.includes('not-seti'))).toEqual([])
  })

  it('refuses an agent without an OpenAI key', () => {
    expect(() => realiseCodex(spec, launcher({}), { ...answering, binary: '/c' })).toThrow(/no OpenAI key/)
  })
})
