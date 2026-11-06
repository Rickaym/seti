import { isValidElement, type ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { Hint } from '@/components/Hint'
import { ThreadsBadge } from './pr-badges'

interface BadgeProps {
  'aria-label': string
  children: unknown[]
}

function element<P>(node: unknown): ReactElement<P> {
  if (!isValidElement<P>(node)) {
    throw new Error('expected a React element')
  }
  return node
}

describe('ThreadsBadge', () => {
  it('shows nothing when every review thread is resolved', () => {
    expect(ThreadsBadge({ count: 0 })).toBeNull()
    expect(ThreadsBadge({ count: 0, bare: true })).toBeNull()
  })

  it('names the count in its hint, plural above one', () => {
    const hint = element<{ text: string; children: unknown }>(ThreadsBadge({ count: 3 }))
    expect(hint.type).toBe(Hint)
    expect(hint.props.text).toBe('3 unresolved review threads')
    const badge = element<BadgeProps>(hint.props.children)
    expect(badge.props['aria-label']).toBe('3 unresolved review threads')
    expect(badge.props.children).toContain(3)
  })

  it('says thread for a single one, and leaves the hint out when bare', () => {
    const badge = element<BadgeProps>(ThreadsBadge({ count: 1, bare: true }))
    expect(badge.type).toBe('span')
    expect(badge.props['aria-label']).toBe('1 unresolved review thread')
  })
})
