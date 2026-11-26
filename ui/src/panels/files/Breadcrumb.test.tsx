import type { FileRoot } from '@seti/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Breadcrumb } from '@/panels/files/Breadcrumb'

const ROOT: FileRoot = {
  id: 'workspace',
  label: 'Workspace',
  path: '/agents/a/workspace',
  kind: 'workspace',
  exists: true,
  writable: true,
}

const render = (dir: string) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <Breadcrumb root={ROOT} dir={dir} onGo={() => undefined} />
    </TooltipProvider>,
  )

describe('Breadcrumb', () => {
  it('draws nothing at the top of a root, which the Root select already names', () => {
    expect(render('')).toBe('')
  })

  it('names the folders below the root and leaves the root to the Root select', () => {
    const html = render('docs/notes')
    expect(html).toContain('aria-label="Up a folder"')
    expect(html).toContain('>docs</button>')
    expect(html).toContain('aria-current="location"')
    expect(html).toContain('>notes</span>')
    expect(html).not.toContain('Workspace')
  })

  it('shows one folder as the place, with Up as the way back to the top', () => {
    const html = render('docs')
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).toContain('aria-label="Up a folder"')
    expect(html).toContain('>docs</span>')
    expect(html).not.toContain('Workspace')
  })
})
