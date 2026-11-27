import { describe, expect, it } from 'vitest'
import { launchMove } from '@/lib/launch-move'

const here = new URL('https://seti.example/#ea')

describe('launchMove', () => {
  it('routes a widget link to an agent inside the running page', () => {
    expect(launchMove('https://seti.example/#agents/abc', here)).toEqual({ kind: 'hash', hash: '#agents/abc' })
  })

  it('stays where the user was when the app icon opens Seti without a route', () => {
    expect(launchMove('https://seti.example/', here)).toBeNull()
    expect(launchMove('https://seti.example/#ea', here)).toBeNull()
  })

  it('opens Needs you from the shortcut without loading the page again', () => {
    expect(launchMove('https://seti.example/?view=needs-you', here)).toEqual({ kind: 'needs-you' })
  })

  it('loads any other address in full', () => {
    expect(launchMove('https://seti.example/share-target', here)).toEqual({
      kind: 'load',
      url: 'https://seti.example/share-target',
    })
    expect(launchMove('https://other.example/#ea', here)).toEqual({ kind: 'load', url: 'https://other.example/#ea' })
    expect(launchMove('https://seti.example/?x=1#ea', here)).toEqual({
      kind: 'load',
      url: 'https://seti.example/?x=1#ea',
    })
  })

  it('ignores an address it cannot read', () => {
    expect(launchMove('https://[', here)).toBeNull()
  })
})
