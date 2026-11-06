import type { Panel } from './grid-layout'

/** Panels that stream live: the focused one, then the most recently focused, to `budget`. */
export function livePanels(
  panels: readonly Panel[],
  { focused, recent, budget }: { focused: string | null; recent: readonly string[]; budget: number },
): Set<string> {
  const rank = (panel: Panel) => {
    if (panel.i === focused) {
      return -1
    }
    const seen = recent.indexOf(panel.agent ?? '')
    return seen === -1 ? recent.length + panels.indexOf(panel) : seen
  }
  const candidates = panels.filter((panel) => panel.agent !== null)
  candidates.sort((a, b) => rank(a) - rank(b))
  return new Set(candidates.slice(0, budget).map((panel) => panel.i))
}

/** Live streams a page may hold over HTTP/1.1, whose six connections per host also carry requests. */
const HTTP1_STREAMS = 3

/** How many agents may stream at once over `protocol`; HTTP/2 and later multiplex them all. */
export const streamBudget = (protocol: string): number =>
  protocol.startsWith('http/1') ? HTTP1_STREAMS : Number.POSITIVE_INFINITY
