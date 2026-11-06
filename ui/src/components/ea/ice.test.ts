import { describe, expect, it } from 'vitest'
import { hasTurn, normalizeIceServers } from './ice'

describe('normalizeIceServers', () => {
  it('keeps credentialed TURN servers as they are', () => {
    const servers = [
      {
        urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:5349'],
        username: 'u',
        credential: 'c',
      },
    ]
    expect(normalizeIceServers(servers)).toEqual(servers)
    expect(hasTurn(normalizeIceServers(servers))).toBe(true)
  })

  it('drops TURN urls without credentials and keeps the STUN ones beside them', () => {
    const servers = [
      { urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478'] },
      { urls: 'turn:x:3478' },
    ]
    expect(normalizeIceServers(servers)).toEqual([{ urls: ['stun:stun.cloudflare.com:3478'] }])
  })

  it('leaves only host candidates when nothing usable is left', () => {
    const none = normalizeIceServers([{ urls: 'turn:x:3478', username: 'u' }, { urls: [] }])
    expect(none).toEqual([])
    expect(hasTurn(none)).toBe(false)
  })
})
