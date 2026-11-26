import { renderToStaticMarkup } from 'react-dom/server'
import MarkdownRoot from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'
import { MAX_REFS, referenceOf, type ReferenceSet } from './reference-set'
import { remarkReferences } from './remark-references'

const PR = 'https://github.com/acme/widgets/pull/12'
const SLACK = 'https://acme.slack.com/archives/C08ABCDEF12/p1731000000123456'
const LINEAR = 'https://linear.app/acme/issue/ENG-42/fix-login'

/** The references of `text` and its markup, with no components in the way. */
function cite(text: string): { set: ReferenceSet; html: string } {
  const set: ReferenceSet = { token: 't0k', refs: [] }
  const html = renderToStaticMarkup(
    <MarkdownRoot remarkPlugins={[remarkGfm, remarkReferences(set)]}>{text}</MarkdownRoot>,
  )
  return { set, html }
}

const hrefs = (set: ReferenceSet) => set.refs.map((ref) => ref.href)
const marks = (html: string) => [...html.matchAll(/<sup data-seti-ref="t0k:(\d+)">/g)].map((match) => match[1])

describe('remarkReferences', () => {
  it('numbers a Markdown link and a bare URL inside sentences', () => {
    const { set, html } = cite(`See [the fix](${PR}) and the thread ${SLACK} for why.`)
    expect(hrefs(set)).toEqual([PR, SLACK])
    expect(html).toContain(`<a href="${PR}" data-seti-ref="t0k:1">the fix</a>`)
    expect(html).toContain(`data-seti-ref="t0k:2">${SLACK}</a>`)
    expect(html).toContain('<section data-seti-sources="t0k"></section>')
  })

  it('turns [^n] footnotes into marks and drops their bodies', () => {
    const { set, html } = cite(`Shipped.[^a] Held.[^b]\n\n[^a]: ${SLACK}\n[^b]: Standup notes, 24 November`)
    expect(set.refs).toEqual([
      { n: 1, href: SLACK, note: null, quote: null },
      { n: 2, href: null, note: 'Standup notes, 24 November', quote: null },
    ])
    expect(marks(html)).toEqual(['1', '2'])
    expect(html).not.toContain('footnote')
    expect(html).not.toContain('Standup notes')
  })

  it('keeps the words of a footnote that also links', () => {
    const { set } = cite(`Held.[^1]\n\n[^1]: Dana in the release thread, ${SLACK}`)
    expect(set.refs[0]).toMatchObject({ href: SLACK, note: 'Dana in the release thread' })
  })

  it('turns [n] with a [n]: url definition into a mark, and [text][id] into a cited link', () => {
    const { set, html } = cite(`The freeze holds [1]. See [the issue][eng].\n\n[1]: ${PR}\n[eng]: ${LINEAR}`)
    expect(hrefs(set)).toEqual([PR, LINEAR])
    expect(marks(html)).toEqual(['1'])
    expect(html).toContain(`<a href="${LINEAR}" data-seti-ref="t0k:2">the issue</a>`)
  })

  it('reuses the number of a URL cited again, across forms', () => {
    const { set, html } = cite(`A [fix](${PR}), again ${PR}, and once more.[^x]\n\n[^x]: ${PR}`)
    expect(hrefs(set)).toEqual([PR])
    expect(html.match(/t0k:1/g)).toHaveLength(3)
  })

  it('leaves a link alone on its line, a whole list item or a table cell as it is', () => {
    const { set, html } = cite(`Sources:\n${PR}\n\n- ${SLACK}\n- [Linear](${LINEAR}).\n\n| PR |\n| --- |\n| ${PR} |`)
    expect(set.refs).toEqual([])
    expect(html).not.toContain('data-seti')
  })

  it('cites links in nested lists in reading order', () => {
    const { set } = cite(`- Top cites [this](${LINEAR})\n  - Nested cites [that](${PR})\n    - Deeper ${SLACK} here`)
    expect(hrefs(set)).toEqual([LINEAR, PR, SLACK])
  })

  it('leaves code blocks, code spans and file paths untouched', () => {
    const { set, html } = cite(`\`${PR}\` and \`ui/src/App.tsx\`\n\n\`\`\`\nsee ${PR} [^1]\n\`\`\``)
    expect(set.refs).toEqual([])
    expect(html).toContain(`<code>${PR}</code>`)
    expect(html).toContain('<code>ui/src/App.tsx</code>')
  })

  it('cites only http and https links', () => {
    const { set } = cite('Mail [me](mailto:a@example.com), run [this](javascript:alert(1)), see [here](/local).')
    expect(set.refs).toEqual([])
  })

  it('ties a quote to the reference inside, after or leading into it', () => {
    const inside = cite(`> We ship on Friday. [Dana](${SLACK})\n\nSo the freeze holds.`)
    expect(inside.set.refs[0]?.quote).toBe('We ship on Friday. Dana')
    const after = cite(`> We ship on Friday.\n\nDana said so in [the thread](${SLACK}).`)
    expect(after.set.refs[0]?.quote).toBe('We ship on Friday.')
    expect(after.html).toContain('<blockquote data-seti-ref="t0k:1">')
    const before = cite(`Dana wrote in [the thread](${SLACK}):\n\n> We ship on Friday.`)
    expect(before.set.refs[0]?.quote).toBe('We ship on Friday.')
    const loose = cite(`> We ship on Friday.\n\nCompare [one](${PR}) and [two](${LINEAR}).`)
    expect(loose.set.refs.map((ref) => ref.quote)).toEqual([null, null])
  })

  it('settles numbers in order of appearance while a message streams in', () => {
    const full = `First [a](${PR}), then ${SLACK} and [c](${LINEAR}).`
    const seen = [12, 30, 60, 75, full.length].map((cut) => hrefs(cite(full.slice(0, cut)).set))
    const settled = hrefs(cite(full).set)
    for (const partial of seen) {
      partial.forEach((href, index) => {
        if (index < partial.length - 1) {
          expect(href).toBe(settled[index])
        }
      })
    }
    expect(settled).toEqual([PR, SLACK, LINEAR])
  })

  it('keeps a half-written footnote as text until its definition arrives', () => {
    const partial = cite('The deploy moved.[^1]\n\n[^1')
    expect(partial.set.refs).toEqual([])
    expect(partial.html).toContain('[^1]')
  })

  it('bounds hostile input: many links, long notes and long quotes', () => {
    const many = Array.from({ length: MAX_REFS + 20 }, (_, i) => `[l${String(i)}](https://example.com/${String(i)})`)
    const { set, html } = cite(`Links ${many.join(' ')} end.`)
    expect(set.refs).toHaveLength(MAX_REFS)
    expect(html).toContain('<a href="https://example.com/118">l118</a>')
    const long = cite(`> ${'quote '.repeat(200)}[^n]\n\n[^n]: ${'note '.repeat(200)} ${PR}`)
    expect(long.set.refs[0]?.quote?.length).toBe(280)
    expect(long.set.refs[0]?.note?.length).toBe(200)
  })

  it('accepts only the marks its own token signs', () => {
    const { set } = cite(`See [x](${PR}).`)
    expect(referenceOf(set, 't0k:1')?.href).toBe(PR)
    expect(referenceOf(set, 'other:1')).toBeNull()
    expect(referenceOf(set, 't0k:2')).toBeNull()
    expect(referenceOf(null, 't0k:1')).toBeNull()
  })

  it('renders no Sources node for a message without references', () => {
    expect(cite('Just words, `code`, and nothing to cite.').html).not.toContain('section')
  })
})
