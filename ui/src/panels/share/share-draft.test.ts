import { describe, expect, it } from 'vitest'
import type { DraftAttachment } from '@/lib/attachments'
import { joinDrafts, sharedText } from '@/panels/share/share-draft'

const file = (name: string): DraftAttachment => ({
  key: name,
  token: `[${name}]`,
  name,
  kind: 'file',
  type: 'PDF',
  size: 10,
  lines: null,
  staged: null,
})

describe('sharedText', () => {
  it('puts the title, text and link on their own lines', () => {
    expect(sharedText({ title: 'Release notes', text: 'Worth a read', url: 'https://example.com/n' })).toBe(
      'Release notes\nWorth a read\nhttps://example.com/n',
    )
  })

  it('leaves out a link or title the text already holds', () => {
    const url = 'https://example.com/n'
    expect(sharedText({ title: 'Notes', text: `Notes: ${url}`, url })).toBe(`Notes: ${url}`)
    expect(sharedText({ title: url, text: '', url })).toBe(url)
    expect(sharedText({ title: '', text: '', url: '' })).toBe('')
  })
})

describe('joinDrafts', () => {
  it('adds the share after the start draft and renames files the draft already has', () => {
    const start = { text: 'Earlier draft', items: [file('report.pdf')] }
    const shared = { text: 'Compare [report.pdf] with [notes.txt]', items: [file('report.pdf'), file('notes.txt')] }
    const joined = joinDrafts(start, shared)
    expect(joined.text).toBe('Earlier draft\n\nCompare [report-2.pdf] with [notes.txt]')
    expect(joined.items.map((item) => [item.name, item.token])).toEqual([
      ['report.pdf', '[report.pdf]'],
      ['report-2.pdf', '[report-2.pdf]'],
      ['notes.txt', '[notes.txt]'],
    ])
  })

  it('takes the share alone when the start page has no draft', () => {
    expect(joinDrafts({ text: '', items: [] }, { text: 'Look', items: [] })).toEqual({ text: 'Look', items: [] })
  })
})
