import { describe, expect, it } from 'vitest'
import { rebaseEdit } from '@/lib/text-rebase'

describe('rebaseEdit', () => {
  it('drops a sent message from the front of what was typed after it', () => {
    expect(rebaseEdit('first message', '', 'first message and more')).toBe(' and more')
    expect(rebaseEdit('first message the trav', 'the trav', 'first message the travker ')).toBe('the travker ')
  })

  it('applies an insertion at the end while the user typed earlier in the text', () => {
    expect(rebaseEdit('see ', 'see [a.png] ', 'please see ')).toBe('please see ')
    expect(rebaseEdit('see ', 'see [a.png] ', 'see you ')).toBe('see [a.png] you ')
  })

  it('replaces the whole text when nothing was typed since', () => {
    expect(rebaseEdit('draft', 'rewound prompt', 'draft')).toBe('rewound prompt')
  })

  it('keeps what the user typed when they changed the replaced text too', () => {
    expect(rebaseEdit('first message', '', 'firm message')).toBe('firm message')
  })
})
