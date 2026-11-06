import { describe, expect, it } from 'vitest'
import { deviceLabel } from './device'

describe('deviceLabel', () => {
  it('names the browser and the system', () => {
    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    const pixel =
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
    const edge =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
    const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'
    expect(deviceLabel(iphone)).toBe('Safari on iPhone')
    expect(deviceLabel(pixel)).toBe('Chrome on Android')
    expect(deviceLabel(edge)).toBe('Edge on Windows')
    expect(deviceLabel(firefox)).toBe('Firefox on Linux')
    expect(deviceLabel('curl/8')).toBe('Browser')
  })

  it('names a Home Screen app on iOS, whose agent has no Safari token', () => {
    const app =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
    expect(deviceLabel(app)).toBe('Web app on iPhone')
  })
})
