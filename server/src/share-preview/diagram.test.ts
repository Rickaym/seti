import {
  createShareInput,
  SHARE_DIAGRAM_SVG_MAX,
  SHARE_DIAGRAMS_MAX,
  updateShareInput,
  type ShareDiagramInput,
} from '@seti/shared'
import { markdownFences } from '@seti/shared/markdown-fences'
import { describe, expect, it } from 'vitest'
import { rasterSize } from './image.js'
import { fillImages, type PreviewInput } from './preview.js'
import { renderPreview } from './render.js'

const SLOW = 60_000
const TOKEN = 'T'.repeat(43)
const TEXT = 'text/plain; charset=utf-8'

const FLOW = 'graph TD\n  A[Start] --> B[Ship]'
const OTHER = 'graph LR\n  X --> Y'

const drawing = (fill: string, width = 200, height = 100) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 ${String(width)} ${String(height)}">` +
  `<rect x="10" y="10" width="80" height="40" fill="${fill}"/></svg>`

const diagram = (source: string, overrides: Partial<ShareDiagramInput> = {}): ShareDiagramInput => ({
  language: 'mermaid',
  source,
  light: drawing('#336699'),
  dark: drawing('#99ccff'),
  ...overrides,
})

const input = (name: string, text: string, kind: PreviewInput['kind']): PreviewInput => ({
  name,
  kind,
  mime: TEXT,
  content: Buffer.from(text),
  images: new Map(),
})

const NOTE = ['# Rollout', '', '```mermaid', FLOW, '```', '', 'Then:', '', '```mermaid', OTHER, '```', ''].join('\n')

describe('fences', () => {
  it('finds fenced blocks with their language, nested ones included, and skips indented code', () => {
    const text =
      '```mermaid title\nA\n```\n\n- item\n\n  ```js\n  x\n  ```\n\n    indented\n\n> ```mermaid\n> B\n> ```\n'
    expect(markdownFences(text)).toEqual([
      { language: 'mermaid', source: 'A' },
      { language: 'js', source: 'x' },
      { language: 'mermaid', source: 'B' },
    ])
  })
})

describe('diagram snapshots on a share page', () => {
  it(
    'draws a fence with a matching snapshot as light and dark images with zoom, and leaves the rest as code',
    async () => {
      const preview = await renderPreview({ ...input('rollout.md', NOTE, 'markdown'), diagrams: [diagram(FLOW)] })
      expect(preview.images).toHaveLength(2)
      expect(preview.images.map((image) => image.mime)).toEqual(['image/png', 'image/png'])
      expect(rasterSize(preview.images[0]?.bytes ?? Buffer.alloc(0))).toEqual({ width: 600, height: 300 })
      const body = fillImages(preview.body, preview.imageKey, TOKEN)
      expect(body).not.toContain('<svg')
      expect(body).toContain('<figure class="diagram" style="--w:200px">')
      expect(body).toContain(`<source media="(prefers-color-scheme: dark)" srcset="${TOKEN}/p/2">`)
      expect(body).toContain(`src="${TOKEN}/p/1" width="200" height="100" alt="mermaid diagram"`)
      expect(body).toContain('<input type="radio" name="seti-d1" id="seti-d1-fit" class="z-fit" checked>')
      expect(body).toContain('<label for="seti-d1-2">200%</label>')
      expect(body).toContain(`<a class="full dark" href="${TOKEN}/p/2"`)
      expect(body).not.toContain('A[Start]')
      expect(body).toContain('<code class="language-mermaid">graph LR')
    },
    SLOW,
  )

  it('keeps every fence as code without snapshots, and never draws one that matches no fence', async () => {
    const plain = await renderPreview(input('rollout.md', NOTE, 'markdown'))
    expect(plain.images).toHaveLength(0)
    expect(plain.body).toContain('<code class="language-mermaid">graph TD')
    const stray = await renderPreview({
      ...input('rollout.md', NOTE, 'markdown'),
      diagrams: [diagram('graph TD\n  A --> Z'), diagram(FLOW, { language: 'plantuml' })],
    })
    expect(stray.images).toHaveLength(0)
    expect(stray.imageKey).toBeNull()
    expect(stray.body).not.toContain('<figure')
  })

  it(
    'draws a repeated fence once and gives each figure its own zoom group',
    async () => {
      const twice = ['```mermaid', FLOW, '```', '', '```mermaid', FLOW, '```', ''].join('\n')
      const preview = await renderPreview({
        ...input('twice.md', twice, 'markdown'),
        diagrams: [diagram(FLOW), diagram(FLOW)],
      })
      expect(preview.images).toHaveLength(2)
      expect(preview.body).toContain('name="seti-d1"')
      expect(preview.body).toContain('name="seti-d2"')
    },
    SLOW,
  )

  it(
    'leaves a fence as code when its drawing does not convert',
    async () => {
      const broken = diagram(FLOW, { light: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect' })
      const preview = await renderPreview({ ...input('rollout.md', NOTE, 'markdown'), diagrams: [broken] })
      expect(preview.images).toHaveLength(0)
      expect(preview.body).toContain('<code class="language-mermaid">graph TD')
    },
    SLOW,
  )

  it(
    'shows a .mmd file as its drawing with the source, when the drawing is of exactly its text',
    async () => {
      const file = `\uFEFF${FLOW}\n`
      const drawn = await renderPreview({ ...input('flow.mmd', file, 'mermaid'), diagrams: [diagram(`${FLOW}\n`)] })
      expect(drawn.label).toBe('Mermaid diagram, 200 \u00d7 100')
      expect(drawn.images).toHaveLength(2)
      expect(drawn.thumb).not.toBeNull()
      expect(drawn.body).toContain('<figure class="diagram"')
      expect(drawn.body).toContain(
        '<summary>View source</summary><pre class="text">graph TD\n  A[Start] --&gt; B[Ship]',
      )
      const text = await renderPreview({ ...input('flow.mmd', file, 'mermaid'), diagrams: [diagram(FLOW)] })
      expect(text.images).toHaveLength(0)
      expect(text.label).toBe('Text, 2 lines')
    },
    SLOW,
  )
})

describe('diagram input', () => {
  const base = { root: 'cwd', path: 'rollout.md' }

  it('defaults to none and takes drawings of fences', () => {
    expect(createShareInput.parse(base).diagrams).toEqual([])
    expect(updateShareInput.parse({}).diagrams).toEqual([])
    expect(createShareInput.parse({ ...base, diagrams: [diagram(FLOW)] }).diagrams).toHaveLength(1)
  })

  it('refuses too many, too large, non-SVG or unknown fields', () => {
    const many = Array.from({ length: SHARE_DIAGRAMS_MAX + 1 }, (_, n) => diagram(`graph TD\n  A${String(n)}`))
    const huge = `<svg>${'x'.repeat(SHARE_DIAGRAM_SVG_MAX)}</svg>`
    const bulky = Array.from({ length: 8 }, (_, n) =>
      diagram(`g${String(n)}`, { light: huge.slice(0, SHARE_DIAGRAM_SVG_MAX) }),
    )
    for (const diagrams of [
      many,
      [diagram(FLOW, { light: huge })],
      [diagram(FLOW, { dark: '<html><script>alert(1)</script></html>' })],
      [diagram(FLOW, { language: 'Mermaid' })],
      [diagram('')],
      [{ ...diagram(FLOW), extra: 1 }],
      bulky,
    ]) {
      expect(createShareInput.safeParse({ ...base, diagrams }).success).toBe(false)
    }
  })
})
