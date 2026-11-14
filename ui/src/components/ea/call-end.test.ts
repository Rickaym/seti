import type { EaCallEndInput } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { CallEndRecorder, lastEndText, type TabStorage } from './call-end'

function setup(stored: string | null = null) {
  const sent: EaCallEndInput[] = []
  let value = stored
  const storage: TabStorage = {
    read: () => value,
    write: (next) => {
      value = next
    },
    remove: () => {
      value = null
    },
  }
  const clock = { now: 0, hidden: false }
  const recorder = new CallEndRecorder({
    send: (report) => sent.push(report),
    storage,
    now: () => clock.now,
    hidden: () => clock.hidden,
  })
  return { recorder, sent, clock, stored: () => value }
}

describe('CallEndRecorder', () => {
  it('reports how long a call ran and how long the page was in the background', () => {
    const { recorder, sent, clock, stored } = setup()
    recorder.connected(true)
    expect(stored()).not.toBeNull()
    clock.now = 60_000
    clock.hidden = true
    recorder.visibility()
    clock.now = 90_000
    recorder.visibility()
    clock.now = 150_000
    recorder.ended('ice-failed')
    expect(sent).toEqual([{ reason: 'ice-failed', auto: true, hidden: true, duration_s: 150, hidden_s: 90 }])
    expect(stored()).toBeNull()
    recorder.ended('hang-up')
    expect(sent).toHaveLength(1)
  })

  it('forgets the background once the page is back on screen', () => {
    const { recorder, sent, clock } = setup()
    recorder.connected(false)
    clock.hidden = true
    recorder.visibility()
    clock.hidden = false
    recorder.visibility()
    recorder.ended('hang-up')
    expect(sent[0]).toMatchObject({ hidden: false, hidden_s: null })
  })

  it('reports a call the page closed on when the tab opens Seti again', () => {
    const left = JSON.stringify({ at: 5, auto: false, hiddenAt: 9 })
    const { recorder, sent, stored } = setup(left)
    recorder.recover()
    expect(sent).toEqual([{ reason: 'page-closed', auto: false, hidden: true, duration_s: null, hidden_s: null }])
    expect(stored()).toBeNull()
    setup('not json').recorder.recover()
  })

  it('reads the last end for the settings', () => {
    expect(lastEndText(null)).toBe('-')
    expect(lastEndText({ reason: 'bot-idle', hidden: true })).toBe('The EA ended an idle call, in the background')
  })
})
