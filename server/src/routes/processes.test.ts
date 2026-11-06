import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentProcesses, MessageBody, ShellOutput } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { messages, tasks } from '../db.js'
import { Proc } from '../proc.js'
import { stoppedPreface } from '../process-stop.js'
import { endSession, runTurn } from '../runner.js'
import {
  backgroundChanged,
  backgroundResult,
  outputFile,
  shellCall,
  shellNotification,
  shellStarted,
  shellUpdated,
} from '../shell-fixtures.js'
import { auditEvents } from '../store/audit.js'
import { USER_AUTH } from '../test-auth.js'
import { waitIdle } from '../wait-idle.js'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seti-process-routes-')))

const payload = (body: MessageBody) => body.payload as { type: string }

/** A turn that leaves a dev server running in the background, then ends. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('../fake-sdk.js')
  const state = { turn: (_text: string): { type: string }[] => [], stop: (_id: string): { type: string }[] => [] }
  const fake = new FakeSdk(function* ({ text }) {
    yield* state.turn(text)
    yield fakeResult()
  })
  fake.onStopTask = (session, shellId) => {
    for (const m of state.stop(shellId)) {
      session.emit(m)
    }
  }
  return { state, fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

const TASK = 'process-routes'
const app = createApp()
const spawned: ChildProcess[] = []

const request = async (route: string, method = 'GET', body?: unknown) =>
  app.request(`/api/tasks/${TASK}${route}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

async function data<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await request(route, method, body)
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

function startsShell(shellId: string): { type: string }[] {
  const call = `toolu_${shellId}`
  return [
    payload(
      shellCall(call, { command: `npm run dev # ${shellId}`, description: 'Dev server', run_in_background: true }),
    ),
    payload(backgroundChanged([shellId, 'Dev server'])),
    payload(shellStarted({ shellId, toolUseId: call, description: 'Dev server', background: true })),
    payload(backgroundResult(call, shellId, TMP)),
  ]
}

beforeAll(async () => {
  await tasks.insert({ id: TASK, title: 'Dev server', repo_id: null, cwd: TMP, worktree: false, pr_urls: [] })
  sdk.state.turn = (text) => (text.includes('dev server') ? startsShell(text.split(' ').at(-1) ?? '') : [])
})

afterAll(async () => {
  for (const child of spawned) {
    child.kill('SIGKILL')
  }
  await endSession(TASK)
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('process routes', () => {
  it('lists a background shell, serves its output and stops it through Claude Code', async () => {
    sdk.state.stop = (shellId) => [
      payload(shellUpdated(shellId, { status: 'killed', end_time: Date.now() })),
      payload(shellNotification(shellId, 'stopped', 'Dev server')),
    ]
    await runTurn(TASK, 'start the dev server bdev1')
    await waitIdle(TASK)
    const listed = await data<AgentProcesses>('/processes')
    expect(listed.open).toBe(true)
    expect(listed.shells).toEqual([
      expect.objectContaining({ id: 'bdev1', status: 'running', command: 'npm run dev # bdev1', has_output: true }),
    ])
    expect(listed.running).toBe(1)
    const output = await data<ShellOutput>('/shells/bdev1/output')
    expect(output).toEqual({ id: 'bdev1', text: '', size_bytes: 0, truncated: false })
    const stopped = await data<AgentProcesses>('/shells/bdev1/stop', 'POST')
    expect(sdk.fake.last?.stoppedTasks).toEqual(['bdev1'])
    await vi.waitFor(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100))
      expect((await data<AgentProcesses>('/processes')).shells[0]?.status).toBe('killed')
    })
    expect(stopped.shells).toHaveLength(1)
    await auditEvents.settled()
    expect((await auditEvents.latest('task.process_stopped'))?.detail).toMatchObject({ shell: 'bdev1', process: 'npm' })
    expect((await request('/shells/bdev1/stop', 'POST')).status).toBe(409)
  })

  it('refuses bad shell ids, unknown shells and processes outside the agent', async () => {
    expect((await request('/shells/..%2Fx/output')).status).toBe(400)
    expect((await request('/shells/bnone/output')).status).toBe(404)
    expect((await request('/processes/stop', 'POST', { pid: process.pid, start_ticks: 1 })).status).toBe(404)
    expect((await request('/processes/stop', 'POST', { pid: -1, start_ticks: 1 })).status).toBe(400)
    expect((await request('/processes/stop', 'POST', { pid: 1 })).status).toBe(400)
  })

  it('signals the shell itself when Claude Code cannot stop it, and tells the agent', async () => {
    sdk.state.stop = () => {
      throw new Error('stop_task is not supported')
    }
    await runTurn(TASK, 'start the dev server bdev2')
    await waitIdle(TASK)
    const shell = (await data<AgentProcesses>('/processes')).shells.find((s) => s.id === 'bdev2')
    expect(shell?.status).toBe('running')
    const target = outputFile('bdev2', TMP)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const claude = spawn('/bin/bash', ['-c', `bash -c 'echo serving; sleep 320; true' > ${target} & wait`], {
      env: { ...process.env, SETI_TASK_ID: TASK },
      stdio: 'ignore',
    })
    spawned.push(claude)
    const pid = await vi.waitFor(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100))
      const found = (await data<AgentProcesses>('/processes')).shells.find((s) => s.id === 'bdev2')?.pid
      expect(found).toBeTypeOf('number')
      return found ?? 0
    })
    expect((await data<ShellOutput>('/shells/bdev2/output')).text).toContain('serving')

    await data<AgentProcesses>('/shells/bdev2/stop', 'POST')
    expect(new Proc().stat(pid)?.state ?? 'Z').toBe('Z')
    const notes = (await messages.page(TASK, 100)).messages.filter((row) => row.kind === 'seti')
    expect(notes.at(-1)?.payload).toEqual({
      error: "Stopped background shell bdev2 (Dev server) at the user's request.",
      stopped: true,
    })
    expect((await stoppedPreface(TASK))?.text).toContain('The user stopped these processes from Seti:')

    await runTurn(TASK, 'carry on')
    await waitIdle(TASK)
    expect(sdk.fake.prompts.at(-1)).toContain('Stopped background shell bdev2')
    expect(await stoppedPreface(TASK)).toBeNull()
  })
})
