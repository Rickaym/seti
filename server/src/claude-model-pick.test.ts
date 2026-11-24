import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Task } from '@seti/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { tasks } from './db.js'
import { settleModelFallback } from './model-fallback.js'
import { sessionOptions, setupKey } from './session-spec.js'
import { modelFallbacks } from './store/model-fallback.js'

createApp()
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-claude-pick-'))

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

let count = 0
async function newTask(picks: Partial<Pick<Task, 'requested_model' | 'requested_effort'>>): Promise<Task> {
  const id = `claude-pick-${String(++count)}`
  await tasks.insert({ id, title: id, repo_id: null, cwd: scratch, worktree: false, pr_urls: [], ...picks })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('Task was not stored')
  }
  return task
}

const FALLBACK = {
  original_model: 'claude-sonnet-5-5',
  fallback_model: 'claude-opus-4-8',
  category: 'cyber',
  request_id: null,
  at: new Date().toISOString(),
}

describe('a Claude Code agent started on a picked model', () => {
  it('starts and resumes its session on the model and effort it was started with', async () => {
    const task = await newTask({ requested_model: 'sonnet', requested_effort: 'high' })
    expect(await sessionOptions(task, new AbortController())).toMatchObject({ model: 'sonnet', effort: 'high' })
    const resumed = await sessionOptions({ ...task, session_id: 'session-1' }, new AbortController())
    expect(resumed).toMatchObject({ model: 'sonnet', effort: 'high', resume: 'session-1' })
  })

  it('leaves the model and effort to Claude Code when none was picked', async () => {
    const options = await sessionOptions(await newTask({}), new AbortController())
    expect(options).not.toHaveProperty('model')
    expect(options).not.toHaveProperty('effort')
  })

  it('keys its setup on the picked model, so a pick never shares a process with the default', async () => {
    const picked = await newTask({ requested_model: 'sonnet', requested_effort: 'high' })
    const plain = await setupKey({ ...picked, requested_model: null, requested_effort: null })
    const { model, effort, ...rest } = JSON.parse(await setupKey(picked)) as Record<string, unknown>
    expect({ model, effort }).toEqual({ model: 'sonnet', effort: 'high' })
    expect(rest).toEqual(JSON.parse(plain))
    expect(plain).not.toContain('"model"')
  })

  it('runs on a fallback until its next session start, which returns to the picked model and ends it', async () => {
    const task = await newTask({ requested_model: 'sonnet' })
    await modelFallbacks.set(task.id, FALLBACK)
    const restarted = await sessionOptions((await tasks.get(task.id)) ?? task, new AbortController())
    expect(restarted).toMatchObject({ model: 'sonnet' })
    await settleModelFallback(task.id, 'claude-opus-4-8')
    expect((await tasks.get(task.id))?.model_fallback).toMatchObject({ fallback_model: 'claude-opus-4-8' })
    await settleModelFallback(task.id, 'claude-sonnet-5-5')
    expect((await tasks.get(task.id))?.model_fallback).toBeNull()
  })
})
