import { describe, expect, it } from 'vitest'
import { parseRange } from './byte-range.js'

const slice = (start: number, end: number) => ({ kind: 'part', start, end })
const FULL = { kind: 'full' }
const NONE = { kind: 'unsatisfiable' }

describe('parseRange', () => {
  it('reads one range in each of its three forms', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual(slice(0, 99))
    expect(parseRange('bytes=500-', 1000)).toEqual(slice(500, 999))
    expect(parseRange('bytes=-100', 1000)).toEqual(slice(900, 999))
    expect(parseRange('bytes=0-0', 1000)).toEqual(slice(0, 0))
    expect(parseRange('bytes=999-999', 1000)).toEqual(slice(999, 999))
    expect(parseRange('bytes=0-', 1000)).toEqual(slice(0, 999))
    expect(parseRange(' bytes=1-2 ', 1000)).toEqual(slice(1, 2))
    expect(parseRange('Bytes=1-2', 1000)).toEqual(slice(1, 2))
    expect(parseRange('bytes=007-010', 1000)).toEqual(slice(7, 10))
  })

  it('clips an end past the file and a suffix longer than it', () => {
    expect(parseRange('bytes=10-5000', 1000)).toEqual(slice(10, 999))
    expect(parseRange('bytes=-5000', 1000)).toEqual(slice(0, 999))
    expect(parseRange(`bytes=0-${'9'.repeat(400)}`, 1000)).toEqual(slice(0, 999))
    expect(parseRange(`bytes=-${'9'.repeat(400)}`, 1000)).toEqual(slice(0, 999))
    expect(parseRange('bytes=0-9007199254740993', 1000)).toEqual(slice(0, 999))
  })

  it('answers a range wholly past the end, or an empty suffix, as unsatisfiable', () => {
    expect(parseRange('bytes=1000-', 1000)).toEqual(NONE)
    expect(parseRange('bytes=1000-2000', 1000)).toEqual(NONE)
    expect(parseRange(`bytes=${'9'.repeat(400)}-`, 1000)).toEqual(NONE)
    expect(parseRange('bytes=9007199254740993-9007199254740995', 1000)).toEqual(NONE)
    expect(parseRange('bytes=-0', 1000)).toEqual(NONE)
    expect(parseRange('bytes=0-', 0)).toEqual(NONE)
    expect(parseRange('bytes=-1', 0)).toEqual(NONE)
  })

  it('ignores a header that does not parse, names several ranges or runs backwards', () => {
    for (const header of [
      undefined,
      '',
      'bytes',
      'bytes=',
      'bytes=-',
      'bytes=5-1',
      'bytes=9-8',
      'bytes=-5-10',
      'bytes=--5',
      'bytes=-5-',
      'bytes=a-b',
      'bytes=1.5-2',
      'bytes=0x10-20',
      'bytes=1e3-',
      'bytes= 1-2',
      'bytes=1 -2',
      'bytes=+1-2',
      'bytes=0-1,5-6',
      'bytes=0-1, 5-6',
      'bytes=0-1,',
      'items=0-1',
      'bytes:0-1',
      '0-1',
      'bytes=0-1\nX: y',
      'bytes=\u0661-\u0662',
    ]) {
      expect(parseRange(header, 1000), JSON.stringify(header)).toEqual(FULL)
    }
  })
})
