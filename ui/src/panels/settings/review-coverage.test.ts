import type { ReviewCoverage, ReviewTool } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { basisLine, hasSiblings } from './review-coverage'

const tool = (name: string, basis: ReviewTool['basis'], reviewed = false): ReviewTool => ({
  rule: `mcp__chat__${name}`,
  name,
  basis,
  outward: basis !== 'unknown',
  reviewed,
})

const coverage = (tools: ReviewTool[], typed: string | null = 'mcp__chat__send'): ReviewCoverage => ({
  server: 'mcp__chat',
  label: 'Chat',
  tool: typed,
  known: true,
  tools,
})

describe('the review checklist', () => {
  it('opens only when the server has other tools left to review', () => {
    expect(hasSiblings(coverage([tool('send', 'annotations'), tool('upload', 'annotations')]))).toBe(true)
    expect(hasSiblings(coverage([tool('send', 'annotations'), tool('upload', 'annotations', true)]))).toBe(false)
    expect(hasSiblings(coverage([tool('send', 'annotations')]))).toBe(false)
    expect(hasSiblings(coverage([tool('upload', 'annotations')], null))).toBe(false)
    expect(hasSiblings({ ...coverage([]), known: false })).toBe(false)
  })

  it('says whether its list comes from annotations, from names or from nothing', () => {
    expect(basisLine(coverage([tool('send', 'annotations'), tool('upload', 'annotations')]))).toBe(
      'Chat marks 2 of its tools as not read-only.',
    )
    expect(basisLine(coverage([tool('send', 'name'), tool('triage', 'unknown')]))).toBe(
      'Chat does not say which of its tools write, so Seti goes by their names. Seti cannot place the ones marked Unknown, so they start unselected.',
    )
    expect(basisLine(coverage([tool('triage', 'unknown'), tool('sync', 'unknown')]))).toBe(
      'Seti cannot tell which Chat tools write, so all are listed and none is selected.',
    )
  })
})
