import { describe, expect, it } from 'vitest'
import { utils, write } from 'xlsx'
import { columnName, rowText } from './grid'
import { readWorkbook } from './sheets'

function fixture(): ArrayBuffer {
  const book = utils.book_new()
  const people = utils.aoa_to_sheet(
    [
      ['Name', 'Joined', 'Score'],
      ['Ada', new Date(Date.UTC(2024, 0, 15)), 3],
      ['Grace', new Date(Date.UTC(2023, 11, 1)), 4],
    ],
    { cellDates: true },
  )
  people.D1 = { t: 's', v: 'Total' }
  people.D2 = { t: 'n', v: 7, f: 'SUM(C2:C3)' }
  people['!ref'] = 'A1:D3'
  people['!merges'] = [{ s: { r: 0, c: 3 }, e: { r: 0, c: 4 } }]
  utils.book_append_sheet(book, people, 'People')
  utils.book_append_sheet(book, utils.aoa_to_sheet([['Notes'], ['second sheet']]), 'Notes')
  return write(book, { type: 'array', bookType: 'xlsx', cellDates: true }) as ArrayBuffer
}

describe('readWorkbook', () => {
  it('reads every sheet with values, dates, formulas and merges', () => {
    const [people, notes] = readWorkbook(fixture())
    expect(people?.name).toBe('People')
    expect(people?.rows[0]).toEqual(['Name', 'Joined', 'Score', 'Total'])
    expect(people?.rows[1]?.[0]).toBe('Ada')
    expect(people?.rows[1]?.[1]).toMatch(/2024|1\/15\/24/)
    expect(people?.rows[1]?.[3]).toBe('7')
    expect(people?.formulas.get('1:3')).toBe('=SUM(C2:C3)')
    expect(people?.merges).toEqual([{ row: 0, col: 3, rows: 1, cols: 2 }])
    expect(people?.columns).toBe(4)
    expect(notes?.rows).toEqual([['Notes'], ['second sheet']])
  })

  it('drops whole rows past the cell cap', () => {
    const [people, notes] = readWorkbook(fixture(), 9)
    expect(people?.rows).toHaveLength(2)
    expect(people?.truncated).toBe(true)
    expect(notes?.rows).toEqual([['Notes']])
    expect(notes?.truncated).toBe(true)
  })

  it('refuses bytes that are no workbook', () => {
    expect(() => readWorkbook(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]).buffer)).toThrow()
  })
})

describe('grid helpers', () => {
  it('names columns the way spreadsheets do', () => {
    expect([0, 25, 26, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA'])
  })

  it('copies a row as tab-separated text, quoting what would break it', () => {
    expect(rowText(['a', 'b\tc', 'say "hi"\n'])).toBe('a\t"b\tc"\t"say ""hi""\n"')
  })
})
