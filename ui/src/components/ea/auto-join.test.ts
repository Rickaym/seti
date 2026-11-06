import { describe, expect, it } from 'vitest'
import { AutoJoin, RETRY_MS, STEADY_MS, type MicPermission } from './auto-join'
import { callReducer, initialCallState, type CallAction, type CallState } from './call-state'

/** A call store that only moves when the test says so. */
class FakeCall {
  state: CallState = initialCallState
  connects: { auto: boolean }[] = []
  hangUps = 0
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = () => this.state

  readonly connect = async (options: { auto: boolean }) => {
    this.connects.push(options)
    this.act({ type: 'connecting', auto: options.auto })
    await Promise.resolve()
  }

  readonly hangUp = async () => {
    this.hangUps += 1
    this.act({ type: 'ended', at: 0, error: null })
    await Promise.resolve()
  }

  act(action: CallAction) {
    this.state = callReducer(this.state, action)
    for (const listener of this.listeners) {
      listener()
    }
  }
}

function setup({ permission = 'granted', leads = true }: { permission?: MicPermission; leads?: boolean } = {}) {
  const call = new FakeCall()
  const timers: { task: () => void; ms: number; cancelled: boolean }[] = []
  const leaders: (() => void)[] = []
  let released = 0
  let now = 0
  let mic: MicPermission = permission
  const autoJoin = new AutoJoin({
    call,
    lead: (onLead) => {
      leaders.push(onLead)
      if (leads) {
        onLead()
      }
      return () => {
        released += 1
      }
    },
    micPermission: async () => Promise.resolve(mic),
    later: (task, ms) => {
      const timer = { task, ms, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    now: () => now,
  })
  const stop = autoJoin.start()
  const fire = () => {
    const timer = timers.findLast((t) => !t.cancelled)
    if (timer === undefined) {
      throw new Error('no timer')
    }
    timer.cancelled = true
    timer.task()
  }
  return {
    call,
    autoJoin,
    stop,
    timers,
    leaders,
    fire,
    released: () => released,
    tick: (ms: number) => {
      now += ms
    },
    setMic: (next: MicPermission) => {
      mic = next
    },
  }
}

const settle = async () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

describe('AutoJoin', () => {
  it('joins asleep once wanted, with the microphone allowed and this tab leading', async () => {
    const { call, autoJoin } = setup()
    await settle()
    expect(call.connects).toEqual([])
    autoJoin.setWanted(true)
    await settle()
    expect(call.connects).toEqual([{ auto: true }])
    expect(autoJoin.getSnapshot()).toBe('joined')
    call.act({ type: 'connected', at: 1 })
    autoJoin.setWanted(true)
    await settle()
    expect(call.connects).toHaveLength(1)
  })

  it('waits for the lead, so only one tab of the browser holds the call', async () => {
    const { call, autoJoin, leaders } = setup({ leads: false })
    autoJoin.setWanted(true)
    await settle()
    expect(call.connects).toEqual([])
    expect(leaders).toHaveLength(1)
    leaders[0]?.()
    await settle()
    expect(call.connects).toEqual([{ auto: true }])
  })

  it('asks for a press when the microphone needs permission, and stays quiet when it is blocked', async () => {
    const asked = setup({ permission: 'prompt' })
    asked.autoJoin.setWanted(true)
    await settle()
    expect(asked.call.connects).toEqual([])
    expect(asked.autoJoin.getSnapshot()).toBe('needs-gesture')
    asked.autoJoin.activate()
    expect(asked.call.connects).toEqual([{ auto: true }])
    expect(asked.autoJoin.getSnapshot()).toBe('joined')

    const blocked = setup({ permission: 'denied' })
    blocked.autoJoin.setWanted(true)
    await settle()
    expect(blocked.call.connects).toEqual([])
    expect(blocked.autoJoin.getSnapshot()).toBe('blocked')
    blocked.autoJoin.activate()
    expect(blocked.call.connects).toEqual([])
  })

  it('rejoins after a drop, backing off while the EA is busy elsewhere', async () => {
    const { call, autoJoin, timers, fire, tick } = setup()
    autoJoin.setWanted(true)
    await settle()
    call.act({ type: 'connected', at: 1 })
    tick(10)
    call.act({ type: 'ended', at: 2, error: 'The EA call dropped' })
    expect(timers.at(-1)?.ms).toBe(RETRY_MS[0])
    fire()
    await settle()
    expect(call.connects).toHaveLength(2)
    call.act({ type: 'ended', at: 3, error: 'The EA is on a call' })
    expect(timers.at(-1)?.ms).toBe(RETRY_MS[1])
    for (const wait of RETRY_MS.slice(2)) {
      fire()
      await settle()
      call.act({ type: 'ended', at: 4, error: 'The EA is on a call' })
      expect(timers.at(-1)?.ms).toBe(wait)
    }
    fire()
    await settle()
    call.act({ type: 'ended', at: 5, error: 'The EA is on a call' })
    expect(timers.at(-1)?.ms).toBe(RETRY_MS.at(-1))

    fire()
    await settle()
    call.act({ type: 'connected', at: 6 })
    tick(STEADY_MS)
    call.act({ type: 'ended', at: 7, error: 'The EA call dropped' })
    expect(timers.at(-1)?.ms).toBe(RETRY_MS[0])
  })

  it('stops for good in this tab once the user hangs up', async () => {
    const { call, autoJoin, timers } = setup()
    autoJoin.setWanted(true)
    await settle()
    call.act({ type: 'connected', at: 1 })
    await call.hangUp()
    await settle()
    expect(autoJoin.getSnapshot()).toBe('held')
    expect(call.connects).toHaveLength(1)
    expect(timers).toEqual([])
  })

  it('hangs up a call it joined when the user turns joining or the wake word off', async () => {
    const { call, autoJoin, released } = setup()
    autoJoin.setWanted(true)
    await settle()
    call.act({ type: 'connected', at: 1 })
    autoJoin.setWanted(false)
    expect(call.hangUps).toBe(1)
    expect(released()).toBe(1)
    expect(autoJoin.getSnapshot()).toBe('off')
    autoJoin.setWanted(true)
    await settle()
    expect(call.connects).toHaveLength(2)
  })

  it('leaves a call the user started alone when joining is turned off', async () => {
    const { call, autoJoin } = setup()
    call.act({ type: 'connecting', auto: false })
    call.act({ type: 'connected', at: 1 })
    autoJoin.setWanted(true)
    await settle()
    autoJoin.setWanted(false)
    expect(call.hangUps).toBe(0)
    expect(call.connects).toEqual([])
  })

  it('lets the lead go when it stops', async () => {
    const { autoJoin, stop, released } = setup()
    autoJoin.setWanted(true)
    await settle()
    stop()
    expect(released()).toBe(1)
  })
})
