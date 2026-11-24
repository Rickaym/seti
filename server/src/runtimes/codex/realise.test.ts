import { describe, expect, it } from 'vitest'
import type { Launcher } from '../../launcher.js'
import type { SessionSpec } from '../../session-spec.js'
import { realiseCodex } from './realise.js'

const spec = { runtime: 'codex', cwd: '/work/project', resume: null } as SessionSpec<'codex'>
const spawn: NonNullable<Launcher['spawn']> = () => {
  throw new Error('not started in this test')
}
const answering = { decide: async () => Promise.reject(new Error('no ask')), abortController: new AbortController() }
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

  it('refuses an agent without an OpenAI key', () => {
    expect(() => realiseCodex(spec, launcher({}), { ...answering, binary: '/c' })).toThrow(/no OpenAI key/)
  })
})
