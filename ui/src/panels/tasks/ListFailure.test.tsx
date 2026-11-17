import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ListFailure } from '@/panels/tasks/ListFailure'

describe('ListFailure', () => {
  it('says in the list why nothing loaded', () => {
    const html = renderToStaticMarkup(<ListFailure error="No response" loaded={false} />)
    expect(html).toContain('role="status"')
    expect(html).toContain('No response')
  })

  it('draws nothing in a list that has agents to show, or no error', () => {
    expect(renderToStaticMarkup(<ListFailure error="Request failed (500)" loaded />)).toBe('')
    expect(renderToStaticMarkup(<ListFailure error={null} loaded={false} />)).toBe('')
  })
})
