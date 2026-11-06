import { describe, expect, it } from 'vitest'
import { isIosAgent } from './ios'

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const IPAD_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const PIXEL =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'

describe('isIosAgent', () => {
  it('finds iPhones, and iPads that ask for desktop sites by their touch screen', () => {
    expect(isIosAgent(IPHONE, 5)).toBe(true)
    expect(isIosAgent(IPAD_DESKTOP, 5)).toBe(true)
  })

  it('leaves out Macs and Android phones', () => {
    expect(isIosAgent(IPAD_DESKTOP, 0)).toBe(false)
    expect(isIosAgent(PIXEL, 5)).toBe(false)
  })
})
