import { describe, expect, it } from 'vitest'
import { textIsUrl, trimUrl, urlPieces } from './bare-urls'

const PR = 'https://github.com/acme/widgets/pull/123'

describe('urlPieces', () => {
  it('splits text around its URLs and keeps sentence punctuation outside them', () => {
    expect(urlPieces(`See ${PR}. Then retry.`)).toEqual([
      { text: 'See ' },
      { text: PR, href: PR },
      { text: '. Then retry.' },
    ])
    expect(urlPieces('No link here')).toEqual([{ text: 'No link here' }])
  })

  it.each([
    [`(${PR})`, PR],
    [`${PR},`, PR],
    [`${PR}?!`, PR],
    ['https://en.wikipedia.org/wiki/Mars_(planet)', 'https://en.wikipedia.org/wiki/Mars_(planet)'],
    ['(https://en.wikipedia.org/wiki/Mars_(planet))', 'https://en.wikipedia.org/wiki/Mars_(planet)'],
    ['http://localhost:5173/a?b=c&d=e#f.', 'http://localhost:5173/a?b=c&d=e#f'],
    ['"https://example.com/quoted"', 'https://example.com/quoted'],
  ])('finds the URL in %s', (text, url) => {
    expect(urlPieces(text).flatMap((piece) => piece.href ?? [])).toEqual([url])
  })

  it('keeps unicode and very long URLs whole', () => {
    const unicode = `https://example.com/caf${String.fromCodePoint(0xe9)}`
    const long = `https://example.com/${'a'.repeat(5000)}`
    expect(urlPieces(`${unicode} and ${long}`).flatMap((piece) => piece.href ?? [])).toEqual([unicode, long])
  })

  it('finds only http and https URLs', () => {
    expect(urlPieces('javascript:alert(1) ftp://example.com mailto:a@example.com')).toEqual([
      { text: 'javascript:alert(1) ftp://example.com mailto:a@example.com' },
    ])
  })

  it('trims nothing from a URL that ends cleanly', () => {
    expect(trimUrl(PR)).toBe(PR)
    expect(trimUrl(`${PR})`)).toBe(PR)
  })
})

describe('textIsUrl', () => {
  it('holds for a link whose text is its URL, as written or as a browser shows it', () => {
    expect(textIsUrl(PR, PR)).toBe(true)
    expect(textIsUrl('www.example.com', 'http://www.example.com')).toBe(true)
    expect(textIsUrl('https://example.com', 'https://example.com/')).toBe(true)
    expect(textIsUrl(`https://example.com/caf${String.fromCodePoint(0xe9)}`, 'https://example.com/caf%C3%A9')).toBe(
      true,
    )
  })

  it('fails for a link with its own text', () => {
    expect(textIsUrl('the PR', PR)).toBe(false)
    expect(textIsUrl('https://example.com/other', 'https://example.com/')).toBe(false)
    expect(textIsUrl('', PR)).toBe(false)
  })
})
