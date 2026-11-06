import { beforeEach, describe, expect, it, vi } from 'vitest'
import { diagramError, renderMermaid, type DiagramTheme } from './diagram-render'

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(),
  render: vi.fn(),
}))

vi.mock('mermaid', () => ({ default: mermaid }))

const theme = (key: string): DiagramTheme => ({
  key,
  background: 'white',
  dark: false,
  font: 'sans-serif',
  variables: {},
})

const SVG = '<svg id="x" viewBox="-8 -8 240.5 120" style="max-width: 240.5px;"><g></g></svg>'

class ParseError extends Error {
  hash = { loc: { first_line: 3 } }
}

describe('renderMermaid', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mermaid.parse.mockResolvedValue({ diagramType: 'flowchart' })
    mermaid.render.mockResolvedValue({ svg: SVG })
  })

  it('returns the svg with its natural size and configures Mermaid once per theme', async () => {
    expect(await renderMermaid('graph TD; A-->B', theme('light'))).toEqual({ svg: SVG, width: 240.5, height: 120 })
    await renderMermaid('graph TD; B-->C', theme('light'))
    expect(mermaid.initialize).toHaveBeenCalledTimes(1)
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: 'strict', startOnLoad: false, theme: 'base' }),
    )
    await renderMermaid('graph TD; B-->C', theme('dark'))
    expect(mermaid.initialize).toHaveBeenCalledTimes(2)
  })

  it('turns a parse error into a message with its line and keeps drawing afterwards', async () => {
    mermaid.parse.mockRejectedValueOnce(new ParseError('Parse error on line 3:\n...A -->\n---^'))
    expect(await renderMermaid('graph TD\nA\nA -->', theme('light'))).toEqual({
      error: { message: 'Parse error on line 3:\n...A -->\n---^', line: 3 },
    })
    expect(mermaid.render).not.toHaveBeenCalled()
    expect(await renderMermaid('graph TD; A-->B', theme('light'))).toMatchObject({ svg: SVG })
  })

  it('reports a render failure instead of throwing', async () => {
    mermaid.render.mockRejectedValueOnce(new Error('boom'))
    expect(await renderMermaid('graph TD; A-->B', theme('light'))).toEqual({ error: { message: 'boom', line: null } })
  })
})

describe('diagramError', () => {
  it('finds the line in the message when the error carries no location', () => {
    expect(diagramError(new Error('Lexical error on line 2. Unrecognized text.'))).toEqual({
      message: 'Lexical error on line 2. Unrecognized text.',
      line: 2,
    })
  })

  it('reads a zero-based parser line and falls back for empty errors', () => {
    expect(diagramError(Object.assign(new Error('bad'), { hash: { line: 4 } })).line).toBe(5)
    expect(diagramError('')).toEqual({ message: 'Could not draw the diagram', line: null })
    expect(diagramError({})).toEqual({ message: 'Could not draw the diagram', line: null })
  })
})
