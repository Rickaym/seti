import { callQualityText, eaCallQuality } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { QualityMeter, readStats } from './call-quality'

type Stat = Record<string, unknown>

function report(voice: Stat, local: Stat = { candidateType: 'relay', relayProtocol: 'udp', protocol: 'udp' }) {
  return new Map<string, Stat>([
    ['T1', { id: 'T1', type: 'transport', selectedCandidatePairId: 'P1' }],
    ['P1', { id: 'P1', type: 'candidate-pair', localCandidateId: 'L1', currentRoundTripTime: 0.084 }],
    ['L1', { id: 'L1', type: 'local-candidate', address: 'phone.local', ...local }],
    ['V1', { id: 'V1', type: 'inbound-rtp', kind: 'audio', jitter: 0.012, ...voice }],
    ['M1', { id: 'M1', type: 'inbound-rtp', kind: 'video', packetsLost: 500 }],
  ])
}

describe('readStats', () => {
  it('reads the voice, the path, and nothing that names an address', () => {
    const sample = readStats(report({ packetsLost: 3, packetsReceived: 997, concealedSamples: 9600 }))
    expect(sample).toEqual({
      lost: 3,
      received: 997,
      concealed: 9600,
      jitterMs: 12,
      rttMs: 84,
      path: 'relay',
      protocol: 'udp',
    })
    expect(JSON.stringify(sample)).not.toContain('phone.local')
  })

  it('counts only concealment a listener hears, and a direct path by its own protocol', () => {
    const voice = { packetsLost: 0, packetsReceived: 10, concealedSamples: 48_000, silentConcealedSamples: 24_000 }
    const sample = readStats(report(voice, { candidateType: 'host', protocol: 'udp', relayProtocol: 'tls' }))
    expect(sample).toMatchObject({ concealed: 24_000, path: 'host', protocol: 'udp' })
  })

  it('has nothing before the voice arrives', () => {
    expect(readStats(new Map())).toBeNull()
  })
})

describe('QualityMeter', () => {
  it('adds up every peer connection the call used and counts the rebuilds', () => {
    const meter = new QualityMeter()
    expect(meter.quality()).toBeNull()
    meter.sample(report({ packetsLost: 10, packetsReceived: 490, concealedSamples: 24_000 }))
    meter.rebuilt()
    meter.sample(
      report({ packetsLost: 0, packetsReceived: 500, concealedSamples: 0 }, { candidateType: 'host', protocol: 'udp' }),
    )
    const quality = meter.quality()
    expect(quality).toEqual({
      lost_pct: 1,
      concealed_s: 0.5,
      jitter_ms: 12,
      rtt_ms: 84,
      path: 'host',
      protocol: 'udp',
      reconnects: 1,
    })
    expect(eaCallQuality.parse(quality)).toEqual(quality)
    expect(callQualityText(eaCallQuality.parse(quality))).toBe('1% lost, 0.5 s filled in, direct over UDP, 1 reconnect')
  })
})
