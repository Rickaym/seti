import { describe, expect, it } from 'vitest'
import { titlebarArea, titlebarVars } from '@/lib/titlebar'

const WINDOWS = { x: 0, y: 0, width: 1302, height: 33 }
const MAC = { x: 78, y: 0, width: 1362, height: 28 }

const overlay = (visible: boolean, rect: typeof WINDOWS) => ({ visible, getTitlebarAreaRect: () => rect })

describe('titlebarArea', () => {
  it('is null without the overlay or while the OS title bar shows', () => {
    expect(titlebarArea(undefined)).toBeNull()
    expect(titlebarArea(overlay(false, WINDOWS))).toBeNull()
  })

  it('is null while the overlay reports an empty strip', () => {
    expect(titlebarArea(overlay(true, { ...WINDOWS, width: 0 }))).toBeNull()
    expect(titlebarArea(overlay(true, { ...WINDOWS, height: 0 }))).toBeNull()
  })

  it('takes the strip beside the window buttons', () => {
    expect(titlebarArea(overlay(true, WINDOWS))).toEqual(WINDOWS)
    expect(titlebarArea(overlay(true, MAC))).toEqual(MAC)
  })
})

describe('titlebarVars', () => {
  it('names each side of the strip in pixels', () => {
    expect(titlebarVars({ x: 78, y: 2, width: 1362.5, height: 28 })).toEqual({
      '--titlebar-area-x': '78px',
      '--titlebar-area-y': '2px',
      '--titlebar-area-width': '1362.5px',
      '--titlebar-area-height': '28px',
    })
  })
})
