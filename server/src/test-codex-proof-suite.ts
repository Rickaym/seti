import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CODEX_SETTINGS_DEFAULTS, readSecondOpinion, type Task } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { sweepCodex } from './codex-install.js'
import { CODEX_ROOT } from './config.js'
import { endSession } from './session-control.js'
import { OPINION_TOOLS } from './seti-tools/second-opinion.js'
import { callSetiTool } from './seti-tools/server.js'
import { codexSettings } from './store/codex-settings.js'
import { secondOpinions } from './store/second-opinions.js'
import { canSandbox, proofRun, USER_FILES, type ProofRun } from './test-codex-proof.js'
import { clearConnections } from './test-connections.js'
import { CLAUDE_OPINION } from './test-opinion-sdk.js'

const PROOF_BINARY = process.env.SETI_CODEX_BIN ?? ''

/** Whether this host can run the proof: the pinned Codex is named and the sandbox works. */
export const proofRuns = (): boolean => PROOF_BINARY !== '' && canSandbox()

/**
 * The real pinned Codex in Seti's sandbox, through its egress proxy with a key only the proxy
 * holds: what a Codex agent may do with the user's answers, and what it never reaches.
 */
export function proofSuite(split: boolean): void {
  const binary = PROOF_BINARY
  const missing = !proofRuns()

  describe.skipIf(missing)(`a Codex agent in Seti's sandbox, ${split ? 'split node' : 'single process'}`, () => {
    let run: ProofRun
    let task: Task

    beforeAll(async () => {
      createApp()
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-codex-proof-'))
      run = await proofRun(scratch, binary, split)
      task = await run.agent()
    }, 60_000)

    afterAll(async () => {
      await endSession(task.id)
      await run.close()
      await codexSettings.set(CODEX_SETTINGS_DEFAULTS)
      await vi.waitFor(async () => {
        await sweepCodex()
        expect(fs.readdirSync(CODEX_ROOT), 'Seti removes its copy once no Codex runs it').toEqual([])
      })
      await clearConnections()
    })

    it('asks before a command and an edit, asks a question, relays a Seti tool and takes a denial', async () => {
      await run.firstTurn(task)
      const told = run.model.told()
      expect(fs.readFileSync(path.join(task.cwd, 'notes.txt'), 'utf8')).toBe('from codex\n')
      expect(fs.existsSync(path.join(task.cwd, 'keep.txt')), 'the denied rm did not run').toBe(true)
      expect(told, 'the answer reaches the model').toContain('\\"answers\\":[\\"Blue\\"]')
      expect(told, 'the model hears of the denial').toContain('rejected by user')
      expect(told).toContain(task.title)
      expect(told, 'a Seti tool above the level is refused').toContain(
        'list_tasks reaches past you, and your Seti control is Self',
      )
    }, 120_000)

    it('holds no key in the sandbox and reaches only the model host, with the key the proxy adds', () => {
      run.egressNoted()
      const env = fs.readFileSync(path.join(task.cwd, 'env.txt'), 'utf8')
      expect(env).not.toContain(run.key)
      expect(env).toMatch(/^SETI_MODEL_KEY=\S+$/m)
      expect(run.model.authorizations.length).toBeGreaterThan(0)
      expect(new Set(run.model.authorizations)).toEqual(new Set([`Bearer ${run.key}`]))
      expect(new Set(run.model.dialled)).toEqual(new Set(['api.openai.com']))
      expect(run.model.refused).toEqual([])
    })

    it("refuses writes to Codex's locked files and to the program's folder", () => {
      const locked = fs.readFileSync(path.join(task.cwd, 'locked.txt'), 'utf8').trim().split('\n')
      expect(locked.map(Number).every((code) => code !== 0)).toBe(true)
      expect(path.dirname(run.program), "Seti's own copy, not the program the test named").not.toBe(
        path.dirname(binary),
      )
      expect(fs.existsSync(path.join(path.dirname(run.program), 'seti-proof'))).toBe(false)
    })

    it("reads the user's CLAUDE.md and lists and loads the user's skill, read-only", async () => {
      await run.skillTurn(task)
      const told = run.model.told()
      expect(told, "the user's CLAUDE.md is the agent's global instructions").toContain(USER_FILES.instructions)
      expect(told, "Seti lists the user's skill").toContain('- proof: PROOF_SKILL_LISTED')
      expect(told, 'the skill loads in the sandbox').toContain(USER_FILES.skill)
    }, 120_000)

    it('stops a turn on an interrupt, and resumes the conversation after a restart', async () => {
      await run.interruptedTurn(task)
      await run.restartAndResume(task)
      const last = run.model.fake.bodies.at(-1) ?? ''
      expect(last, 'the resumed thread keeps the earlier turns').toContain('"input_text","text":"go"')
      expect(last).toContain('"input_text","text":"wait"')
      expect(last).toMatch(/(\\n|")again"/)
      expect(last).toContain('<turn_aborted>')
      expect(last).toContain('The user restarted your Codex session from Seti')
    }, 120_000)

    it("asks Claude for a second opinion through Seti's tool relay and hears its answer as data", async () => {
      await run.asksOpinion(task)
      const told = run.model.told()
      expect(told).toContain(CLAUDE_OPINION)
      expect(told).toContain('<second-opinion runtime=\\"claude\\"')
      expect(await secondOpinions.spend(task.id)).toMatchObject([{ runtime: 'claude', count: 1, usd: 0.002 }])
    }, 120_000)

    it("answers a Claude agent's second opinion from Codex in a bare sandbox, with the key only the proxy adds", async () => {
      const claude = await run.claudeAgent()
      run.model.play([[{ say: 'Codex says: release the queue lock before evict().' }]])
      const [tool] = OPINION_TOOLS
      if (tool === undefined) {
        throw new Error('no second_opinion tool')
      }
      const result = await callSetiTool(tool, claude.id, { question: 'Is the lock order safe?' })
      run.egressNoted()
      const text = result.content[0]?.text ?? ''
      expect(result.isError, text).toBeUndefined()
      expect(readSecondOpinion(text)).toMatchObject({
        runtime: 'codex',
        answer: 'Codex says: release the queue lock before evict().',
        estimated: true,
      })
      expect(new Set(run.model.authorizations)).toEqual(new Set([`Bearer ${run.key}`]))
      expect(new Set(run.model.dialled)).toEqual(new Set(['api.openai.com']))
      expect(run.model.refused).toEqual([])
    }, 120_000)
  })
}
