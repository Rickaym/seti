import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '@/components/Markdown'
import { LinkedText } from '@/components/links/LinkedText'
import { TooltipProvider } from '@/components/ui/tooltip'

const SLACK = 'https://acme.slack.com/archives/C08ABCDEF12/p1731000000123456'
const PR = 'https://github.com/acme/widgets/pull/123'

const markdown = (text: string, html = false) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <Markdown text={text} html={html} />
    </TooltipProvider>,
  )

const pills = (markup: string) => [...markup.matchAll(/data-link-pill="([^"]+)"/g)].map((match) => match[1])

describe('link pills in Markdown', () => {
  it('shows a bare URL as a pill that opens it in a new tab and copies as the URL', () => {
    const html = markdown(`The thread: ${SLACK}.`)
    expect(pills(html)).toEqual(['slack'])
    expect(html).toContain(`href="${SLACK}"`)
    expect(html).toContain(`data-link-url="${SLACK}"`)
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer"')
    expect(html).toContain('>Slack message</span></a>.')
  })

  it('shows a Markdown link whose text is its URL as a pill', () => {
    expect(pills(markdown(`[${PR}](${PR}) and <${PR}>`))).toEqual(['github', 'github'])
    expect(markdown(`[${PR}](${PR})`)).toContain('>acme/widgets#123</span>')
  })

  it('keeps a link with its own text as a normal link', () => {
    const html = markdown(`[the fix](${PR})`)
    expect(pills(html)).toEqual([])
    expect(html).toContain(`<a href="${PR}" target="_blank" rel="noreferrer"`)
    expect(html).toContain('>the fix</a>')
  })

  it('leaves URLs in code spans and code links alone', () => {
    const html = markdown(`\`${SLACK}\` and [\`${PR}\`](${PR})`)
    expect(pills(html)).toEqual([])
    expect(html).toContain(`>${SLACK}</code>`)
    expect(html).toContain(`>${PR}</code></a>`)
  })

  it('refuses a javascript link and pills a bare URL in sanitized HTML', () => {
    const html = markdown(`[javascript:alert(1)](javascript:alert(1)) <a href="${PR}">${PR}</a>`, true)
    expect(html).not.toContain('javascript:alert(1)"')
    expect(pills(html)).toEqual(['github'])
  })
})

describe('link pills in plain text', () => {
  it('shows each URL as a pill and keeps the rest as text', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <LinkedText text={`See ${SLACK} and ${PR}, or https://example.com/docs.`} />
      </TooltipProvider>,
    )
    expect(pills(html)).toEqual(['slack', 'github', 'web'])
    expect(html).toContain('>example.com/docs</span></a>.')
    expect(html.startsWith('See ')).toBe(true)
  })
})
