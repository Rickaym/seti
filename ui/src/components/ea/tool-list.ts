import type { EaTool, EaToolGate } from '@seti/shared'

export const GATE_LABEL: Record<EaToolGate, string> = {
  runs: 'Runs',
  asks: 'Asks first',
  word: 'On your word',
}

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`

/** How many tools the EA has and how many wait for the user, such as "120 tools; 51 ask first". */
export function countText(tools: readonly EaTool[]): string {
  const asks = tools.filter((t) => t.gate === 'asks').length
  const word = tools.filter((t) => t.gate === 'word').length
  const parts = [plural(tools.length, 'tool', 'tools'), plural(asks, 'asks first', 'ask first')]
  if (word > 0) {
    parts.push(`${String(word)} on your word`)
  }
  return parts.join('; ')
}

/** The tools whose name, area, line or gate holds every word of the query. */
export function matchTools(tools: readonly EaTool[], query: string): EaTool[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return [...tools]
  }
  return tools.filter((tool) => {
    const text = [tool.name, tool.name.replaceAll('_', ' '), tool.area, tool.summary, GATE_LABEL[tool.gate]]
      .join(' ')
      .toLowerCase()
    return words.every((word) => text.includes(word))
  })
}

export interface ToolGroup {
  area: string
  tools: EaTool[]
}

/** Tools by area, areas in the order their first tool comes. */
export function groupTools(tools: readonly EaTool[]): ToolGroup[] {
  const groups = new Map<string, EaTool[]>()
  for (const tool of tools) {
    const group = groups.get(tool.area) ?? []
    group.push(tool)
    groups.set(tool.area, group)
  }
  return [...groups].map(([area, list]) => ({ area, tools: list }))
}
