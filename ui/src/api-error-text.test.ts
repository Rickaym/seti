import { describe, expect, it } from 'vitest'
import { errorText } from './api'

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
