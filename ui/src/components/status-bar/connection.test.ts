import { describe, expect, it } from 'vitest'
import { connectionOf } from '@/components/status-bar/connection'
import { apiTone } from '@/components/status-bar/tone'

const signs = { online: true, reconnecting: false, error: null, lastOk: 1000 }

describe('connectionOf', () => {
  it('is pending until the first answer, then up', () => {
    expect(connectionOf({ ...signs, lastOk: null })).toBe('pending')
    expect(connectionOf(signs)).toBe('up')
  })

  it('calls unanswered polls reconnecting, whatever error came before', () => {
    expect(connectionOf({ ...signs, reconnecting: true })).toBe('reconnecting')
    expect(connectionOf({ ...signs, reconnecting: true, error: 'No response', lastOk: null })).toBe('reconnecting')
  })

  it('is down only when the server answers with an error', () => {
    expect(connectionOf({ ...signs, error: 'Request failed (500)' })).toBe('down')
  })

  it('is offline when the browser is, whatever the polls said last', () => {
    expect(connectionOf({ ...signs, online: false, reconnecting: true, error: 'x' })).toBe('offline')
  })
})

describe('apiTone', () => {
  it('keeps a lost link quiet and marks only a server error', () => {
    expect(apiTone('reconnecting')).toBe('muted')
    expect(apiTone('offline')).toBe('muted')
    expect(apiTone('down')).toBe('danger')
    expect(apiTone('up')).toBe('default')
    expect(apiTone('pending')).toBe('default')
  })
})
