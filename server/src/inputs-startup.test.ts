import type { PrInput } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { messages, tasks } from './db.js'
import { deliverInputs, wakeWaiting } from './inputs.js'
import { isRunning } from './runner.js'

const update: PrInput = {
  source: 'pr',
  kind: 'merged',
  subject: 'acme/web#7',
  title: 'acme/web#7 was merged',
  body: '',
  url: 'https://github.com/acme/web/pull/7',
}

describe('handing over updates before the app registers turn prefaces', () => {
  it('keeps the update and logs instead of throwing, as at server startup', async () => {
    await tasks.insert({ id: 'early', title: 'Early', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await expect(deliverInputs('early', [update])).resolves.toEqual({
      outcome: 'delivered',
      reason: 'Handing to the agent in a few seconds',
    })
    await expect(wakeWaiting()).resolves.toBeUndefined()
    expect(isRunning('early')).toBe(false)
    expect((await messages.page('early', 10)).messages).toMatchObject([{ kind: 'input', payload: { kind: 'merged' } }])
    expect(write).toHaveBeenCalledWith('could not hand updates to task early: Nothing is waiting for the agent\n')
    write.mockRestore()
  })
})
