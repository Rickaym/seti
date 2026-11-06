import { describe, expect, it } from 'vitest'
import { relativeAsset } from './markdown-images'

describe('relativeAsset', () => {
  it('resolves against the folder of the Markdown file', () => {
    expect(relativeAsset('reports/drill.md', 'charts/latency.png')).toBe('reports/charts/latency.png')
    expect(relativeAsset('reports/drill.md', './a.png')).toBe('reports/a.png')
    expect(relativeAsset('reports/drill.md', '../img/a.png')).toBe('img/a.png')
    expect(relativeAsset('drill.md', 'a%20b.png?raw=1#x')).toBe('a b.png')
  })

  it('leaves absolute, remote, data and escaping links alone', () => {
    expect(relativeAsset('a/b.md', 'https://example.com/x.png')).toBeNull()
    expect(relativeAsset('a/b.md', 'data:image/png;base64,AAAA')).toBeNull()
    expect(relativeAsset('a/b.md', '/home/x.png')).toBeNull()
    expect(relativeAsset('a/b.md', '../../x.png')).toBeNull()
    expect(relativeAsset('a/b.md', '%E0%A4%A')).toBeNull()
  })
})
