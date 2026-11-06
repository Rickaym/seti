const RATE = 24_000
const NOTES = [
  { hz: 660, seconds: 0.18 },
  { hz: 880, seconds: 0.32 },
] as const
const PEAK = 0.18
const FADE_S = 0.03

/** A soft two-note chime as 16-bit mono PCM samples. */
function chimeSamples(): Int16Array {
  const total = NOTES.reduce((sum, note) => sum + Math.round(note.seconds * RATE), 0)
  const samples = new Int16Array(total)
  let offset = 0
  for (const note of NOTES) {
    const length = Math.round(note.seconds * RATE)
    const fade = Math.round(FADE_S * RATE)
    for (let i = 0; i < length; i += 1) {
      const envelope = Math.min(1, i / fade, (length - 1 - i) / fade)
      samples[offset + i] = Math.round(Math.sin((2 * Math.PI * note.hz * i) / RATE) * envelope * PEAK * 0x7fff)
    }
    offset += length
  }
  return samples
}

function wav(samples: Int16Array): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(at + i, value.charCodeAt(i))
    }
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, RATE, true)
  view.setUint32(28, RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((sample, i) => {
    view.setInt16(44 + i * 2, sample, true)
  })
  return buffer
}

/** Plays the chime on `sinkId`, or on the system output when it is null or cannot be chosen. */
export async function playTestTone(sinkId: string | null, sinkSupported: boolean): Promise<void> {
  const url = URL.createObjectURL(new Blob([wav(chimeSamples())], { type: 'audio/wav' }))
  const audio = new Audio(url)
  const release = () => {
    URL.revokeObjectURL(url)
  }
  audio.addEventListener('ended', release, { once: true })
  try {
    if (sinkSupported && sinkId !== null) {
      await audio.setSinkId(sinkId)
    }
    await audio.play()
  } catch (e) {
    release()
    throw e
  }
}
