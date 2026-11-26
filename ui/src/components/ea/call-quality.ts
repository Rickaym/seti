import type { EaCallQuality } from '@seti/shared'

type Stat = Record<string, unknown>
type Stats = ReadonlyMap<string, Stat>
type Path = EaCallQuality['path']
type Protocol = EaCallQuality['protocol']

/** WebRTC decodes Opus at 48 kHz, the rate its concealed sample counts are in. */
const OPUS_RATE = 48_000
const PATHS: readonly string[] = ['host', 'srflx', 'prflx', 'relay']
const PROTOCOLS: readonly string[] = ['udp', 'tcp', 'tls']

/** What one getStats report says of the EA's voice and the network path under it. */
interface Sample {
  lost: number
  received: number
  concealed: number
  jitterMs: number
  rttMs: number | null
  path: Path
  protocol: Protocol
}

const NO_SAMPLE: Sample = { lost: 0, received: 0, concealed: 0, jitterMs: 0, rttMs: null, path: null, protocol: null }

const numberOf = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places

function find(stats: Stats, test: (stat: Stat) => boolean): Stat | undefined {
  for (const stat of stats.values()) {
    if (test(stat)) {
      return stat
    }
  }
  return undefined
}

function selectedPair(stats: Stats): Stat | undefined {
  const transport = find(stats, (stat) => stat.type === 'transport')
  const id = textOf(transport?.selectedCandidatePairId)
  const chosen = id === null ? undefined : stats.get(id)
  return chosen ?? find(stats, (stat) => stat.type === 'candidate-pair' && stat.nominated === true)
}

function pathOf(local: Stat | undefined): { path: Path; protocol: Protocol } {
  const type = textOf(local?.candidateType)
  const path = type !== null && PATHS.includes(type) ? (type as Path) : null
  const raw = textOf(path === 'relay' ? local?.relayProtocol : local?.protocol)
  return { path, protocol: raw !== null && PROTOCOLS.includes(raw) ? (raw as Protocol) : null }
}

/** The EA's voice and its path from one getStats report; null before the voice arrives. */
export function readStats(stats: Stats): Sample | null {
  const voice = find(stats, (stat) => stat.type === 'inbound-rtp' && stat.kind === 'audio')
  if (voice === undefined) {
    return null
  }
  const pair = selectedPair(stats)
  const localId = textOf(pair?.localCandidateId)
  const rtt = pair?.currentRoundTripTime
  return {
    lost: Math.max(0, numberOf(voice.packetsLost)),
    received: numberOf(voice.packetsReceived),
    concealed: Math.max(0, numberOf(voice.concealedSamples) - numberOf(voice.silentConcealedSamples)),
    jitterMs: numberOf(voice.jitter) * 1000,
    rttMs: typeof rtt === 'number' ? rtt * 1000 : null,
    ...pathOf(localId === null ? undefined : stats.get(localId)),
  }
}

/** Adds up the samples of every peer connection a call used, across rebuilds of its path. */
export class QualityMeter {
  private done = { lost: 0, received: 0, concealed: 0 }
  private current: Sample | null = null
  private reconnects = 0

  readonly sample = (stats: Stats): void => {
    this.current = readStats(stats) ?? this.current
  }

  /** The call is rebuilding its path; the next peer connection counts from zero. */
  readonly rebuilt = (): void => {
    if (this.current !== null) {
      this.done = {
        lost: this.done.lost + this.current.lost,
        received: this.done.received + this.current.received,
        concealed: this.done.concealed + this.current.concealed,
      }
    }
    this.current = null
    this.reconnects += 1
  }

  readonly quality = (): EaCallQuality | null => {
    const last = this.current ?? NO_SAMPLE
    const lost = this.done.lost + last.lost
    const received = this.done.received + last.received
    if (lost + received === 0) {
      return null
    }
    return {
      lost_pct: round((100 * lost) / (lost + received), 1),
      concealed_s: round((this.done.concealed + last.concealed) / OPUS_RATE, 1),
      jitter_ms: round(last.jitterMs, 0),
      rtt_ms: last.rttMs === null ? null : round(last.rttMs, 0),
      path: last.path,
      protocol: last.protocol,
      reconnects: this.reconnects,
    }
  }
}
