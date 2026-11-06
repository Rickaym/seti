import type { Root } from 'mdast'
import { describe, expect, it } from 'vitest'
import { remarkNoImages } from './mod-markdown'

describe("a mod's Markdown", () => {
  it('shows images as links, so a README loads nothing from the hosts it names', () => {
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'See ' },
            { type: 'image', url: 'https://tracker.example/pixel.png', alt: 'the map' },
          ],
        },
      ],
    }
    expect(remarkNoImages()(tree)).toEqual({
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'See ' },
            { type: 'link', url: 'https://tracker.example/pixel.png', children: [{ type: 'text', value: 'the map' }] },
          ],
        },
      ],
    })
  })
})
