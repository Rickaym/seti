import { describe, expect, it } from 'vitest'
import { LAYER_INPUT_MAX, parseTextLayer, textLayerHtml, type PageText } from './pdf-text.js'

type Box = [number, number, number, number]

const attrs = ([x0, y0, x1, y1]: Box) =>
  `xMin="${String(x0)}" yMin="${String(y0)}" xMax="${String(x1)}" yMax="${String(y1)}"`

const word = (box: Box, text: string) => `<word ${attrs(box)}>${text}</word>`

const line = (box: Box, ...words: string[]) => `<line ${attrs(box)}>\n${words.join('\n')}\n</line>`

const page = (width: string, height: string, ...lines: string[]) =>
  `<page width="${width}" height="${height}">\n<flow><block>\n${lines.join('\n')}\n</block></flow>\n</page>`

const doc = (...pages: string[]) =>
  `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><doc>\n${pages.join('\n')}\n</doc></body></html>`

const heading = line(
  [72, 54.768, 240.12, 76.968],
  word([72, 54.768, 128.04, 76.968], 'Page'),
  word([134.712, 54.768, 148.056, 76.968], '1'),
  word([154.728, 54.768, 240.12, 76.968], 'heading'),
)

const LETTER = { width: 1200, height: 1553 }

describe('parseTextLayer', () => {
  it('reads pages, lines and words in order, joining words with spaces', () => {
    const body = line([72, 94, 150, 104], word([72, 94, 92, 104], 'Line'), word([95, 94, 101, 104], '0'))
    const pages = parseTextLayer(doc(page('612.000000', '792.000000', heading, body), page('612', '792')))
    const round = (n: number) => Math.round(n * 1000) / 1000
    const rounded = pages.map((p) =>
      p === null
        ? null
        : { ...p, lines: p.lines.map((l) => ({ ...l, width: round(l.width), height: round(l.height) })) },
    )
    expect(rounded).toEqual([
      {
        width: 612,
        height: 792,
        lines: [
          {
            x: 72,
            y: 54.768,
            width: 168.12,
            height: 22.2,
            text: 'Page 1 heading',
            run: 'across',
          },
          { x: 72, y: 94, width: 78, height: 10, text: 'Line 0', run: 'across' },
        ],
      },
      { width: 612, height: 792, lines: [] },
    ])
  })

  it('decodes the five XML entities once and strips control characters', () => {
    const text = '&lt;script&gt;a&amp;amp;b&quot;&apos;&#60;\u0001'
    const [first] = parseTextLayer(doc(page('612', '792', line([10, 10, 100, 20], word([10, 10, 100, 20], text)))))
    expect(first?.lines[0]?.text).toBe('<script>a&amp;b"\'&#60;')
  })

  it('keeps a page whose size does not parse as null, so later pages keep their numbers', () => {
    const pages = parseTextLayer(doc(page('NaN', '792', heading), page('-612', '792'), page('612', '792', heading)))
    expect(pages.map((p) => p?.lines.length ?? null)).toEqual([null, null, 1])
  })

  it('drops lines with numbers that are not plain decimals or boxes that are empty', () => {
    const bad = [
      line([Number.NaN, 10, 100, 20], word([10, 10, 100, 20], 'nan')),
      line([Infinity, 10, 100, 20], word([10, 10, 100, 20], 'inf')),
      `<line xMin="1e3" yMin="10" xMax="100" yMax="20">${word([10, 10, 100, 20], 'exp')}</line>`,
      `<line xMin="0x10" yMin="10" xMax="100" yMax="20">${word([10, 10, 100, 20], 'hex')}</line>`,
      line([100, 10, 50, 20], word([10, 10, 100, 20], 'backwards')),
      line([10, 10, 100, 20]),
      line([10, 10, 100, 20], word([10, 10, 100, 20], '   ')),
      line([800, 10, 900, 20], word([800, 10, 900, 20], 'off the page')),
    ]
    const [first] = parseTextLayer(doc(page('612', '792', ...bad)))
    expect(first?.lines).toEqual([])
  })

  it('cuts negative and overflowing boxes to the page either way up', () => {
    const [first] = parseTextLayer(doc(page('612', '792', line([-50, -5, 900, 20], word([-50, -5, 900, 20], 'wide')))))
    expect(first?.lines[0]).toMatchObject({ x: 0, y: 0, width: 792, height: 20 })
  })

  it('reads no markup inside a word, and ignores words outside a line and unknown tags', () => {
    const injected = '<word xMin="1" yMin="1" xMax="9" yMax="9">a<img src=x onerror=alert(1)>b</word>'
    const xhtml = doc(
      page(
        '612',
        '792',
        word([1, 1, 9, 9], 'orphan'),
        line([10, 10, 100, 20], injected, word([10, 10, 100, 20], 'kept')),
        '<script>alert(1)</script>',
      ),
    )
    const [first] = parseTextLayer(xhtml)
    expect(first?.lines.map((l) => l.text)).toEqual(['kept'])
  })

  it('reads no more than 50 pages and stops at the input cap', () => {
    const many = doc(...Array.from({ length: 60 }, () => page('612', '792', heading)))
    expect(parseTextLayer(many)).toHaveLength(50)
    const padded = ' '.repeat(LAYER_INPUT_MAX) + page('612', '792', heading)
    expect(parseTextLayer(padded)).toEqual([])
  })

  it('caps the words of a line and the characters of its text', () => {
    const words = Array.from({ length: 1500 }, (_, n) => word([n, 10, n + 1, 20], 'abc'))
    const [first] = parseTextLayer(doc(page('612', '792', line([0, 10, 600, 20], ...words))))
    expect(first?.lines[0]?.text).toHaveLength(2000)
  })

  it('counts and cuts text by the characters a reader sees', () => {
    const flag = '\u{1F3F3}\u{FE0F}\u200D\u{1F308}'
    const [first] = parseTextLayer(
      doc(page('612', '792', line([0, 10, 600, 20], word([0, 10, 600, 20], flag.repeat(2500))))),
    )
    expect(first?.lines[0]?.text).toBe(flag.repeat(2000))
    const html = textLayerHtml(
      {
        width: 612,
        height: 792,
        lines: [{ x: 0, y: 0, width: 12, height: 10, text: `e\u0301${flag}`, run: 'across' }],
      },
      LETTER,
    )
    expect(html).toContain('scaleX(1)')
  })

  it('reads a turned line from the way its words step', () => {
    const down = line([515, 72, 537, 240], word([515, 72, 537, 128], 'Page'), word([515, 134, 537, 148], '1'))
    const up = line([10, 72, 30, 240], word([10, 180, 30, 240], 'Page'), word([10, 72, 30, 170], 'two'))
    const tall = line([40, 72, 50, 240], word([40, 72, 50, 240], 'Vertical'))
    const short = line([40, 300, 46, 310], word([40, 300, 46, 310], '1'))
    const [first] = parseTextLayer(doc(page('612', '792', down, up, tall, short)))
    expect(first?.lines.map((l) => l.run)).toEqual(['down', 'up', 'down', 'across'])
  })
})

describe('textLayerHtml', () => {
  const one = (lines: PageText['lines']): PageText => ({ width: 612, height: 792, lines })

  it('places each line in percentages of the page, sized from its height, a line break apart', () => {
    const html = textLayerHtml(
      one([
        { x: 61.2, y: 79.2, width: 120, height: 20, text: 'Hello world', run: 'across' },
        { x: 0, y: 0, width: 6, height: 10, text: 'x', run: 'across' },
      ]),
      LETTER,
    )
    expect(html).toBe(
      '<div class="tl">' +
        '<span style="left:10%;top:10%;font-size:3.268cqw;transform:scaleX(0.909)">Hello world</span><br>' +
        '<span style="left:0%;top:0%;font-size:1.634cqw;transform:scaleX(1)">x</span></div>',
    )
  })

  it('escapes every character that could open markup or end an attribute', () => {
    const html = textLayerHtml(
      one([{ x: 0, y: 0, width: 100, height: 10, text: `</span><script>"'&`, run: 'across' }]),
      LETTER,
    )
    expect(html).toContain('&lt;/span&gt;&lt;script&gt;&quot;&#39;&amp;</span>')
    expect(html).not.toContain('<script')
  })

  it('turns down and up lines about their start corner', () => {
    const html = textLayerHtml(
      one([
        { x: 100, y: 100, width: 20, height: 120, text: 'down', run: 'down' },
        { x: 200, y: 100, width: 20, height: 120, text: 'up', run: 'up' },
      ]),
      LETTER,
    )
    expect(html).toContain('left:19.608%;top:12.626%;font-size:3.268cqw;transform:rotate(90deg) scaleX(2.5)')
    expect(html).toContain('left:32.68%;top:27.778%;font-size:3.268cqw;transform:rotate(-90deg) scaleX(5)')
  })

  it('swaps the size of a turned page to match its image, and leaves off a layer that fits neither', () => {
    const lines = [{ x: 700, y: 72, width: 22, height: 168, text: 'Page 1', run: 'down' as const }]
    expect(textLayerHtml(one(lines), { width: 1200, height: 927 })).toContain('left:91.162%;top:11.765%')
    expect(textLayerHtml(one(lines), { width: 1000, height: 1000 })).toBe('')
  })

  it('cuts lines to the page as shown and leaves off those outside it', () => {
    const html = textLayerHtml(
      one([
        { x: 600, y: 0, width: 100, height: 10, text: 'edge', run: 'across' },
        { x: 700, y: 0, width: 50, height: 10, text: 'outside', run: 'across' },
      ]),
      LETTER,
    )
    expect(html).toContain('left:98.039%;top:0%;font-size:1.634cqw;transform:scaleX(0.5)">edge')
    expect(html).not.toContain('outside')
    expect(textLayerHtml(one([{ x: 700, y: 0, width: 50, height: 10, text: 'x', run: 'across' }]), LETTER)).toBe('')
  })

  it('renders nothing for a missing page, a page with no lines or an image with no size', () => {
    const lines = [{ x: 0, y: 0, width: 10, height: 10, text: 'a', run: 'across' as const }]
    expect(textLayerHtml(null, LETTER)).toBe('')
    expect(textLayerHtml(undefined, LETTER)).toBe('')
    expect(textLayerHtml(one([]), LETTER)).toBe('')
    expect(textLayerHtml(one(lines), { width: 0, height: 0 })).toBe('')
  })
})
