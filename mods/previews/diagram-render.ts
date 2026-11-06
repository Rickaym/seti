import type { Mermaid, MermaidConfig } from 'mermaid'

/** Colours and font the diagrams take from Seti's theme; `key` changes with them. */
export interface DiagramTheme {
  key: string
  background: string
  dark: boolean
  font: string
  variables: Record<string, string>
}

export interface DiagramError {
  message: string
  /** The 1-based source line the parser stopped at, when it says. */
  line: number | null
}

export type Rendered = { svg: string; width: number; height: number } | { error: DiagramError }

let loading: Promise<Mermaid> | null = null
const loadMermaid = async () => (loading ??= import('mermaid').then((module) => module.default))

const lineOf = (error: unknown, message: string): number | null => {
  const hash = (error as { hash?: { loc?: { first_line?: unknown }; line?: unknown } } | null)?.hash
  const located = hash?.loc?.first_line ?? (typeof hash?.line === 'number' ? hash.line + 1 : undefined)
  if (typeof located === 'number') {
    return located
  }
  const match = /\bline:? (\d+)/i.exec(message)
  return match === null ? null : Number(match[1])
}

/** What a parser or renderer threw, as a message and the line it points at. */
export function diagramError(error: unknown): DiagramError {
  let raw = typeof error === 'string' ? error : ''
  if (error instanceof Error) {
    raw = error.message
  }
  const message = raw.trim() === '' ? 'Could not draw the diagram' : raw.trim()
  return { message, line: lineOf(error, message) }
}

function sizeOf(svg: string): { width: number; height: number } {
  const box = /viewBox="[-\d.e]+ [-\d.e]+ ([\d.e]+) ([\d.e]+)"/.exec(svg)
  return { width: Number(box?.[1] ?? 0), height: Number(box?.[2] ?? 0) }
}

const configOf = (theme: DiagramTheme): MermaidConfig => ({
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  htmlLabels: false,
  theme: 'base',
  darkMode: theme.dark,
  fontFamily: theme.font,
  themeVariables: { ...theme.variables, darkMode: theme.dark, fontFamily: theme.font },
})

let queue: Promise<unknown> = Promise.resolve()
let appliedTheme: string | null = null
let renders = 0

async function draw(source: string, theme: DiagramTheme): Promise<Rendered> {
  try {
    const mermaid = await loadMermaid()
    if (appliedTheme !== theme.key) {
      mermaid.initialize(configOf(theme))
      appliedTheme = theme.key
    }
    await mermaid.parse(source)
    renders += 1
    const { svg } = await mermaid.render(`seti-mermaid-${String(renders)}`, source)
    return { svg, ...sizeOf(svg) }
  } catch (e) {
    return { error: diagramError(e) }
  }
}

/** Draws one diagram at a time, since Mermaid's config is global; never throws. */
export async function renderMermaid(source: string, theme: DiagramTheme): Promise<Rendered> {
  const next = queue.then(async () => draw(source, theme))
  queue = next
  return next
}
