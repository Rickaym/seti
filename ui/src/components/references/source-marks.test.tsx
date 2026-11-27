import type { SourceMatch } from '@seti/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AsReadAt } from '@/components/references/source-marks'
import { sourceFacts } from '@/components/references/source-match'
import { TooltipProvider } from '@/components/ui/tooltip'

const source = { kind: 'file', container: 'acme/notes', place: 'acme/notes', at: null, permalink: '' } as const
const match = (extra: Partial<SourceMatch>): SourceMatch => ({
  href: 'https://github.com/acme/notes/blob/main/docs/a.md',
  source,
  verified: false,
  unread: false,
  ...extra,
})

describe('source marks', () => {
  it('says a branch link matched what was read at a commit', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <AsReadAt commit="abc1234" />
      </TooltipProvider>,
    )
    expect(html).toContain('data-testid="source-as-read"')
    expect(html).toContain('as read at abc1234')
  })

  it('adds the commit to the facts of a branch link only', () => {
    expect(sourceFacts(match({ as_read_at: 'abc1234' }), 'docs/a.md')).toBe('acme/notes, as read at abc1234')
    expect(sourceFacts(match({}), 'docs/a.md')).toBe('acme/notes')
  })
})
