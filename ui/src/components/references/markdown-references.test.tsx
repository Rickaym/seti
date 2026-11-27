import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '@/components/Markdown'
import { TooltipProvider } from '@/components/ui/tooltip'

const PR = 'https://github.com/acme/widgets/pull/12'
const SLACK = 'https://acme.slack.com/archives/C08ABCDEF12/p1731000000123456'
const LINEAR = 'https://linear.app/acme/issue/ENG-42/fix-login'

const render = (text: string, options: { html?: boolean; references?: boolean } = {}) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <Markdown text={text} {...options} />
    </TooltipProvider>,
  )

describe('references in Markdown', () => {
  it('keeps a link text, labels a bare URL and adds a mark after each', () => {
    const html = render(`See [the fix](${PR}) and ${SLACK} for why.`)
    expect(html).toContain(`<a href="${PR}" target="_blank" rel="noreferrer"`)
    expect(html).toContain('>the fix</a><a href=')
    expect(html).toContain('>Slack message</a><a href=')
    expect(html).toContain('aria-label="Source 1: acme/widgets#12"')
    expect(html).toContain('>[2]</a>')
    expect(html).not.toContain('data-seti-ref')
  })

  it('shows a bare URL in a sentence as a short name with its mark, never the clipped URL', () => {
    const file = 'https://acme.slack.com/files/U08ABCDEF12/F08ABCDEF12/q3-release-evaluation.pdf'
    const page = 'https://example.com/runbooks/release'
    const html = render(
      `Open it here: ${file} and the fix is ${PR}, tracked in ${LINEAR}. The [review](${PR}) and ` +
        `[${page}](${page}) agree, see ${page}. Do not run \`${page}\` by hand.`,
    )
    expect(html).toContain('>Slack file q3 release evaluation</a>')
    expect(html).toContain(`<a href="${file}"`)
    expect(html).toContain('>acme/widgets#12</a>')
    expect(html).toContain('>ENG-42</a>')
    expect(html).toContain('>review</a>')
    expect(html.match(/>example\.com<\/a>/g)).toHaveLength(2)
    expect(html).toContain('>[4]</a>.')
    expect([...html.matchAll(/>\[(\d)\]<\/a>/g)].map((match) => match[1])).toEqual(['1', '2', '3', '2', '4', '4'])
    expect(html).toContain(`>${page}</code>`)
    expect(html).not.toContain(`>${file.slice('https://'.length)}`)
    expect(html).not.toContain(String.fromCodePoint(0x2026))
  })

  it('ends with a Sources list holding each source once, as links that copy as their URL', () => {
    const html = render(`A [fix](${PR}), again ${PR}, and ${SLACK}.`)
    expect(html.match(/data-source="/g)).toHaveLength(2)
    expect(html).toContain('aria-label="Sources"')
    expect(html).toContain(`data-link-url="${PR}"`)
    expect(html).toContain('github.com')
    expect(html).toContain('acme.slack.com')
  })

  it('shows no Sources list without references', () => {
    expect(render(`Only a chip:\n${PR}`)).not.toContain('Sources')
  })

  it('puts a source line under a quote tied to a reference', () => {
    const html = render(`> We ship on Friday.\n\nDana said so in [the thread](${SLACK}).`)
    expect(html).toContain('<figure')
    expect(html).toContain('data-testid="quote-source"')
  })

  it('lets raw HTML fake neither a mark nor a Sources list', () => {
    const fake = '<sup data-seti-ref="x:1">[1]</sup> <section data-seti-sources="x">Sources</section>'
    const html = render(`Plain ${fake}`, { html: true })
    expect(html).not.toContain('data-reference')
    expect(html).not.toContain('aria-label="Sources"')
  })

  it('renders documents without references when asked', () => {
    const html = render(`See [the fix](${PR}).[^1]\n\n[^1]: ${SLACK}`, { references: false })
    expect(html).not.toContain('data-reference')
    expect(html).not.toContain('aria-label="Sources"')
  })
})
