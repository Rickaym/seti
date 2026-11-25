import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MessageBody } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { tasks } from '../db.js'
import { endSession, runTurn } from '../runner.js'
import { backgroundChanged, backgroundResult, shellCall, shellStarted } from '../shell-fixtures.js'
import { waitIdle } from '../wait-idle.js'
import { atWork } from './busy.js'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seti-dream-busy-')))
const payload = (body: MessageBody) => body.payload as { type: string }

/** A turn that leaves a dev server running and, when asked, a second background task beside it. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('../fake-sdk.js')
  const state = { turn: (_text: string): { type: string }[] => [] }
  const fake = new FakeSdk(function* ({ text }) {
    yield* state.turn(text)
    yield fakeResult()
  })
  return { state, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const TASK = 'dream-busy'

function devServer(withTask: boolean): { type: string }[] {
  const call = 'toolu_bdev'
  const running: [string, string][] = [
    ['bdev', 'Dev server'],
    ...(withTask ? [['agent1', 'Review'] as [string, string]] : []),
  ]
  return [
    payload(shellCall(call, { command: 'npm run dev', description: 'Dev server', run_in_background: true })),
    payload(backgroundChanged(...running)),
    payload(shellStarted({ shellId: 'bdev', toolUseId: call, description: 'Dev server', background: true })),
    payload(backgroundResult(call, 'bdev', TMP)),
  ]
}

beforeAll(async () => {
  await tasks.insert({ id: TASK, title: 'Dev', repo_id: null, cwd: TMP, worktree: false, pr_urls: [] })
})

afterAll(async () => {
  await endSession(TASK)
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('why an agent is at work, for a dream', () => {
  it('is null for an agent with no turn and no background work', async () => {
    expect(await atWork(TASK)).toBeNull()
  })

  it('names a background command an idle agent left running', async () => {
    sdk.state.turn = () => devServer(false)
    await runTurn(TASK, 'start the dev server')
    await waitIdle(TASK)
    expect(await atWork(TASK)).toBe(
      'The agent runs no turn, but 1 background command still runs in its session; it dreams when it ends, or stop it in its Processes.',
    )
  })

  it('counts background work that is not a command apart', async () => {
    sdk.state.turn = () => devServer(true)
    await runTurn(TASK, 'start the dev server and a review')
    await waitIdle(TASK)
    expect(await atWork(TASK)).toMatch(/1 background command and 1 subagent or other background task still run/)
  })
})
