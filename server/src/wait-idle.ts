import { expect, vi } from 'vitest'
import { isRunning } from './runner.js'
import { laneSettled } from './task-lane.js'

/** Waits until the turn ended and the lane reported it; turn-end listeners may start another. */
export async function waitIdle(taskId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      await laneSettled(taskId)
      expect(isRunning(taskId)).toBe(false)
    },
    { interval: 5 },
  )
}
