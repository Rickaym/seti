import { expect, vi } from 'vitest'
import { closed, turnEnd, type Case } from './case.js'
import { refusal } from './cases-failures.js'
import { SUITE_CWD } from './subject.js'

/** What the sandbox launcher hands every process, with egress placeholders in place of keys. */
const LAUNCHER_ENV = {
  PATH: '/sandbox/bin:/usr/bin',
  HOME: '/sandbox/home',
  HTTPS_PROXY: 'https://egress.invalid:3128',
  ANTHROPIC_API_KEY: 'egress-placeholder',
  OPENAI_API_KEY: 'egress-placeholder',
}

/** Secrets in Seti's own environment, which no process of an agent may see. */
const SETI_SECRETS = {
  ANTHROPIC_API_KEY: 'sk-seti-own-anthropic',
  OPENAI_API_KEY: 'sk-seti-own-openai',
  GH_TOKEN: 'gh-seti-own-token',
  SETI_DATABASE_PASSWORD: 'seti-own-password',
}

/** A variable name that says it holds a credential. */
const CREDENTIAL_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i

/** Starting the runtime: through the launcher, in the task's folder, with no secret inside. */
export const LAUNCH: Case[] = [
  {
    id: 'LN-1',
    title: "the process starts through the launcher's spawn exactly once, in the spec's folder",
    proves: 'RT-2 start through the launcher; design 4.1',
    run: async (subject) => {
      const rig = subject.rig({ turns: [[{ say: 'a' }], [{ say: 'b' }]] })
      const run = await subject.open(rig)
      run.send('one')
      await turnEnd(run, 1)
      run.send('two')
      await turnEnd(run, 2)
      expect(rig.spawns.map((spawn) => spawn.cwd)).toEqual([SUITE_CWD])
      expect(rig.selfStarts).toEqual([])
      await closed(run)
    },
  },
  {
    id: 'LN-2',
    title: "the process gets the launcher's environment plus the adapter's own, and no secret of Seti's",
    proves: 'SEC and EGR: no key inside the sandbox; RT-2',
    run: async (subject) => {
      for (const [name, value] of Object.entries(SETI_SECRETS)) {
        vi.stubEnv(name, value)
      }
      try {
        const rig = subject.rig({ turns: [], launcher: { env: LAUNCHER_ENV } })
        const run = await subject.open(rig)
        run.send('one')
        await turnEnd(run, 1)
        await closed(run)
        const env = rig.spawns[0]?.env ?? {}
        expect(env).toMatchObject(LAUNCHER_ENV)
        const values = Object.values(env).join('\n')
        for (const secret of Object.values(SETI_SECRETS)) {
          expect(values).not.toContain(secret)
        }
        const added = Object.keys(env).filter((name) => !(name in LAUNCHER_ENV))
        expect(added.filter((name) => CREDENTIAL_NAME.test(name))).toEqual([])
      } finally {
        vi.unstubAllEnvs()
      }
    },
  },
  {
    id: 'LN-3',
    title: 'a sandboxed launcher that cannot spawn is refused, and the runtime never starts by itself',
    proves: 'design 4.1: the adapter never spawns; a sandboxed task never runs on the host',
    run: async (subject) => {
      const rig = subject.rig({ turns: [], launcher: { spawn: 'missing' } })
      await refusal(subject, rig)
      expect(rig.selfStarts).toEqual([])
      expect(rig.spawns).toEqual([])
    },
  },
]
