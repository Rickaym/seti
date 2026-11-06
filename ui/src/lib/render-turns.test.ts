import { describe, expect, it } from 'vitest'
import { createRenderTurns } from '@/lib/render-turns'

/** Turns whose frames advance only when the test says so. */
function setup() {
  const frames: (() => void)[] = []
  const turns = createRenderTurns((run) => frames.push(run))
  const started: string[] = []
  const wait = (key: string, first = false) =>
    turns.wait(key, first, () => {
      started.push(key)
    })
  const paint = () => {
    for (const run of frames.splice(0)) {
      run()
    }
  }
  return { wait, paint, started }
}

describe('createRenderTurns', () => {
  it('starts the first waiter at once and the rest one per painted frame', () => {
    const { wait, paint, started } = setup()
    const endA = wait('a')
    const endB = wait('b')
    wait('c')
    expect(started).toEqual(['a'])
    paint()
    expect(started).toEqual(['a'])
    endA()
    expect(started).toEqual(['a'])
    paint()
    expect(started).toEqual(['a', 'b'])
    endB()
    paint()
    expect(started).toEqual(['a', 'b', 'c'])
  })

  it('puts a waiter that comes first ahead of the queue, not ahead of the holder', () => {
    const { wait, paint, started } = setup()
    const endA = wait('a')
    wait('b')
    wait('focused', true)
    endA()
    paint()
    expect(started).toEqual(['a', 'focused'])
  })

  it('drops a waiter that stops waiting, and frees the turn of a holder that goes', () => {
    const { wait, paint, started } = setup()
    const endA = wait('a')
    const stopB = wait('b')
    wait('c')
    stopB()
    endA()
    paint()
    expect(started).toEqual(['a', 'c'])
  })

  it('starts a newcomer at once when nothing holds a turn or waits for a frame', () => {
    const { wait, paint, started } = setup()
    wait('a')()
    paint()
    wait('b')
    expect(started).toEqual(['a', 'b'])
  })
})
