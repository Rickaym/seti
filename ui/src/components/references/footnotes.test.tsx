import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '@/components/Markdown'
import { TooltipProvider } from '@/components/ui/tooltip'

const SLACK = 'https://acme.slack.com/archives/C08ABCDEF12/p1731000000123456'

const render = (text: string) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <Markdown text={text} />
    </TooltipProvider>,
  )

const FOOTNOTED = `The deploy moved to Friday.[^1] The freeze holds.[^2]

[^1]: Dana in the release thread, ${SLACK}
[^2]: Standup notes, 24 November`

describe('footnotes in a message', () => {
  it('never link into the page, so a click cannot change the hash the router reads', () => {
    const html = render(FOOTNOTED)
    expect(html).not.toContain('href="#')
    expect(html).not.toContain('user-content-fn')
  })

  it('show no Footnotes heading', () => {
    expect(render(FOOTNOTED)).not.toMatch(/<h2[^>]*>Footnotes<\/h2>/)
  })

  it('give two messages with the same footnotes no shared ids', () => {
    const html = render(FOOTNOTED) + render(FOOTNOTED)
    expect(html).not.toMatch(/\sid="/)
  })

  it('render as numbered marks with the footnote words in the Sources list', () => {
    const html = render(FOOTNOTED)
    expect(html).toContain('data-reference="1"')
    expect(html).toContain('data-reference="2"')
    expect(html).toContain(`data-link-url="${SLACK}"`)
    expect(html).toContain('Standup notes, 24 November')
  })
})
