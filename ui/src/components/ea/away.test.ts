import { describe, expect, it } from 'vitest'
import { AwayWatch, awayText, backgroundSilences, micHealth, sourceEnergy, type Hearing } from './away'

const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/142.0 Mobile Safari/537.36'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
const DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/142.0 Safari/537.36'

function rig(hearings: (Hearing | null)[], micOn = true) {
  let now = 0
  const notes: string[] = []
  let reopened = 0
  const watch = new AwayWatch({
    hearing: async () => Promise.resolve(hearings.shift() ?? null),
    micOn: () => micOn,
    reopen: async () => {
      reopened += 1
      return Promise.resolve()
    },
    note: (text) => notes.push(text),
    now: () => now,
  })
  const away = async (ms: number) => {
    await watch.hidden()
    now += ms
    await watch.shown()
  }
  return { away, notes, reopened: () => reopened, watch }
}

describe('backgroundSilences', () => {
  it('holds for Android and iOS, not for desktop browsers', () => {
    expect(backgroundSilences(ANDROID, 5)).toBe(true)
    expect(backgroundSilences(IPHONE, 5)).toBe(true)
    expect(backgroundSilences(DESKTOP, 0)).toBe(false)
  })
})

describe('awayText', () => {
  it('says how long in seconds or minutes', () => {
    expect(awayText(42_000)).toBe('You were away for 42 s; the EA could not hear you')
    expect(awayText(125_000)).toBe('You were away for 2 min; the EA could not hear you')
  })
})

describe('micHealth', () => {
  it('reads a track as live, muted, ended or missing', () => {
    expect(micHealth(null)).toBe('none')
    expect(micHealth({ readyState: 'ended', muted: false } as MediaStreamTrack)).toBe('ended')
    expect(micHealth({ readyState: 'live', muted: true } as MediaStreamTrack)).toBe('muted')
    expect(micHealth({ readyState: 'live', muted: false } as MediaStreamTrack)).toBe('live')
  })
})

describe('sourceEnergy', () => {
  it('reads the audio media source, and null without one', () => {
    const report = (stats: object[]) => new Map(stats.map((s, i) => [String(i), s])) as unknown as RTCStatsReport
    expect(
      sourceEnergy(report([{ type: 'inbound-rtp' }, { type: 'media-source', kind: 'audio', totalAudioEnergy: 0.5 }])),
    ).toBe(0.5)
    expect(sourceEnergy(report([{ type: 'media-source', kind: 'video' }]))).toBeNull()
  })
})

describe('AwayWatch', () => {
  it('notes an absence in which the microphone sent only silence', async () => {
    const { away, notes, reopened } = rig([
      { mic: 'live', energy: 1.5 },
      { mic: 'live', energy: 1.5 },
    ])
    await away(120_000)
    expect(notes).toEqual(['You were away for 2 min; the EA could not hear you'])
    expect(reopened()).toBe(0)
  })

  it('stays quiet when the EA kept hearing the room', async () => {
    const { away, notes } = rig([
      { mic: 'live', energy: 1.5 },
      { mic: 'live', energy: 1.52 },
    ])
    await away(120_000)
    expect(notes).toEqual([])
  })

  it('reopens a microphone the system muted or ended, and notes the absence', async () => {
    const { away, notes, reopened } = rig([
      { mic: 'live', energy: null },
      { mic: 'muted', energy: null },
      { mic: 'live', energy: null },
      { mic: 'ended', energy: null },
    ])
    await away(30_000)
    await away(30_000)
    expect(reopened()).toBe(2)
    expect(notes).toHaveLength(2)
  })

  it('says nothing for a short absence, a muted call or no call', async () => {
    const short = rig([
      { mic: 'live', energy: 1 },
      { mic: 'live', energy: 1 },
    ])
    await short.away(3_000)
    const muted = rig(
      [
        { mic: 'live', energy: 1 },
        { mic: 'live', energy: 1 },
      ],
      false,
    )
    await muted.away(60_000)
    const ended = rig([{ mic: 'live', energy: 1 }, null])
    await ended.away(60_000)
    expect([...short.notes, ...muted.notes, ...ended.notes]).toEqual([])
  })

  it('forgets an absence once reset', async () => {
    const { watch, notes } = rig([
      { mic: 'live', energy: 1 },
      { mic: 'live', energy: 1 },
    ])
    await watch.hidden()
    watch.reset()
    await watch.shown()
    expect(notes).toEqual([])
  })
})
