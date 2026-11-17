import { describe, expect, it } from 'vitest'
import { errorText, isUnreachable, RequestError } from './api'

describe('errorText', () => {
  it('names an unreachable server instead of each browser fetch error', () => {
    for (const message of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) {
      expect(errorText(new TypeError(message))).toBe('Seti could not be reached')
    }
  })

  it('keeps other errors, code bugs included, as they are', () => {
    expect(errorText(new TypeError('x is undefined'))).toBe('x is undefined')
    expect(errorText(new Error('The agent cannot take messages now'))).toBe('The agent cannot take messages now')
    expect(errorText('plain')).toBe('plain')
  })
})

describe('isUnreachable', () => {
  it('covers a timeout, a lost network and a proxy that could not reach Seti', () => {
    expect(isUnreachable(new DOMException('The operation timed out.', 'TimeoutError'))).toBe(true)
    expect(isUnreachable(new TypeError('Failed to fetch'))).toBe(true)
    for (const status of [502, 503, 504]) {
      expect(isUnreachable(new RequestError(status, 'Request failed'))).toBe(true)
    }
  })

  it('leaves an error Seti itself answered with, and code bugs, as failures', () => {
    expect(isUnreachable(new RequestError(500, 'The database is restarting'))).toBe(false)
    expect(isUnreachable(new RequestError(404, 'No such agent'))).toBe(false)
    expect(isUnreachable(new TypeError('x is undefined'))).toBe(false)
  })
})
