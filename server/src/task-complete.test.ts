import {
  displayStatus,
  failed,
  isComplete,
  needsYou,
  prStates,
  runningSubtasks,
  type LinkedPrState,
  type SubtaskStatus,
  type TaskStatus,
} from '@seti/shared'
import { describe, expect, it } from 'vitest'

const A = 'https://github.com/o/r/pull/1'
const B = 'https://github.com/o/r/pull/2'

const task = (pr_urls: string[], status: TaskStatus = 'idle', asking = false) => ({ status, pr_urls, asking })

describe('isComplete', () => {
  it('is false without linked PRs', () => {
    expect(isComplete(task([]), prStates({}))).toBe(false)
  })

  it('is true when every linked PR is merged', () => {
    expect(isComplete(task([A, B]), prStates({ [A]: 'merged', [B]: 'merged' }))).toBe(true)
  })

  it('lets a PR closed without merging pass when another one merged', () => {
    expect(isComplete(task([A, B]), prStates({ [A]: 'merged', [B]: 'closed' }))).toBe(true)
  })

  it('is false when the PRs were only closed', () => {
    expect(isComplete(task([A, B]), prStates({ [A]: 'closed', [B]: 'closed' }))).toBe(false)
  })

  it('is false while a PR is still open', () => {
    expect(isComplete(task([A, B]), prStates({ [A]: 'merged', [B]: 'open' }))).toBe(false)
  })

  it('is false for a draft PR, which GitHub reports as open', () => {
    expect(isComplete(task([A]), prStates({ [A]: 'open' }))).toBe(false)
  })

  it('is false while a PR has no known state', () => {
    expect(isComplete(task([A, B]), prStates({ [A]: 'merged' }))).toBe(false)
  })

  it('counts a merged PR Seti unlinked, until a new PR is linked and still open', () => {
    expect(isComplete(task([]), prStates({ [A]: 'merged' }))).toBe(true)
    expect(isComplete(task([]), prStates({ [A]: 'closed' }))).toBe(false)
    expect(isComplete(task([B]), prStates({ [A]: 'merged', [B]: 'open' }))).toBe(false)
    expect(isComplete(task([B]), prStates({ [A]: 'merged' }))).toBe(false)
  })

  it.each<TaskStatus>(['running', 'stopped', 'error', 'interrupted'])('is false for a %s task', (status) => {
    expect(isComplete(task([A], status), prStates({ [A]: 'merged' }))).toBe(false)
  })
})

describe('displayStatus', () => {
  const merged: Record<string, LinkedPrState> = { [A]: 'merged' }
  const subtasks = (...statuses: SubtaskStatus[]) => statuses.map((status) => ({ status }))

  it('shows complete for an idle task whose PRs landed', () => {
    expect(displayStatus(task([A]), prStates(merged), 0)).toBe('complete')
    expect(displayStatus(task([A]), prStates(merged), runningSubtasks(subtasks('completed', 'stopped')))).toBe(
      'complete',
    )
  })

  it('keeps the stored status otherwise', () => {
    expect(displayStatus(task([A], 'running'), prStates(merged), 0)).toBe('running')
    expect(displayStatus(task([A]), prStates({ [A]: 'open' }), runningSubtasks(subtasks('completed')))).toBe('idle')
  })

  it('shows asking for an idle task whose turn ended on a question, which needs the user', () => {
    expect(displayStatus(task([], 'idle', true), prStates({}), 0)).toBe('asking')
    expect(displayStatus(task([A], 'idle', true), prStates({ [A]: 'open' }), 0)).toBe('asking')
    expect(needsYou('asking')).toBe(true)
    expect(failed('asking')).toBe(false)
    expect(failed('error') && failed('interrupted') && needsYou('error')).toBe(true)
  })

  it('lets landed PRs, a running subagent or a non-idle status win over asking', () => {
    expect(displayStatus(task([A], 'idle', true), prStates(merged), 0)).toBe('complete')
    expect(displayStatus(task([], 'idle', true), prStates({}), runningSubtasks(subtasks('running')))).toBe('running')
    expect(displayStatus(task([], 'error', true), prStates({}), 0)).toBe('error')
  })

  it.each<TaskStatus>(['idle', 'stopped', 'error', 'interrupted'])(
    'shows running for a %s task while a subagent runs, and never complete',
    (status) => {
      expect(
        displayStatus(task([A], status), prStates(merged), runningSubtasks(subtasks('completed', 'running'))),
      ).toBe('running')
      expect(displayStatus(task([], status), prStates({}), runningSubtasks(subtasks('running')))).toBe('running')
    },
  )

  it('counts the running subagents', () => {
    expect(runningSubtasks(subtasks('running', 'completed', 'running', 'unknown'))).toBe(2)
    expect(runningSubtasks([])).toBe(0)
  })
})
