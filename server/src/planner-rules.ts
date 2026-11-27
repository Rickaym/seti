import type { PlannerOutput, TaskSetup } from '@seti/shared'
import { titleFor } from './planner-title.js'

export interface PlannerCatalog {
  packs: { id: string; name: string; description: string; linked_by_default: boolean; builtin: boolean }[]
  /** The MCP servers on by default, the only ones the planner may name: it turns them off. */
  mcp: { name: string }[]
}

/** What the caller fixed already, so the planner leaves it alone. */
export interface PlanPins {
  title?: string | undefined
}

/** The planner only picks among what is on by default and narrows it; it never turns access on. */
export interface AgentPlan {
  title: string
  context_pack_ids: string[]
  mcp_disabled: string[]
  setup: Omit<TaskSetup, 'withheld'>
}

const byName = <T extends { name: string }>(items: readonly T[], name: string) =>
  items.find((item) => item.name.toLowerCase() === name.trim().toLowerCase())

type Pack = PlannerCatalog['packs'][number]

const findPacks = (names: readonly string[], pool: readonly Pack[]) => [
  ...new Set(
    names.flatMap((name) => {
      const pack = byName(pool, name)
      return pack === undefined ? [] : [pack]
    }),
  ),
]

function pickPacks(raw: PlannerOutput, catalog: PlannerCatalog) {
  const defaults = catalog.packs.filter((pack) => pack.linked_by_default)
  const linked = findPacks(
    raw.link_packs,
    catalog.packs.filter((pack) => !pack.linked_by_default),
  )
  const unlinked = findPacks(
    raw.unlink_packs,
    defaults.filter((pack) => !pack.builtin),
  )
  const packs = [...defaults.filter((pack) => !unlinked.includes(pack)), ...linked]
  return {
    ids: packs.map((pack) => pack.id),
    linked: linked.map((pack) => pack.name),
    unlinked: unlinked.map((pack) => pack.name),
  }
}

/** MCP servers on by default that the answer turns off; it turns none on. */
function pickMcpOff(raw: PlannerOutput, catalog: PlannerCatalog): string[] {
  const named = raw.disable_mcp.flatMap((name) => {
    const server = byName(catalog.mcp, name)
    return server === undefined ? [] : [server.name]
  })
  return [...new Set(named)]
}

/** The model's answer to a message, or an empty one with the reason the call failed. */
export interface PlannerAnswer {
  raw: PlannerOutput
  message: string
  reason: string | null
  ms: number
}

/** Holds the answer to the rules: only what exists, and nothing turned on beyond the defaults. */
export function checkPlan(answer: PlannerAnswer, catalog: PlannerCatalog, pins: PlanPins = {}): AgentPlan {
  const { raw, message } = answer
  const packs = pickPacks(raw, catalog)
  const mcpOff = pickMcpOff(raw, catalog)
  const titled = pins.title === undefined ? titleFor(raw.title, message) : { title: pins.title, problem: null }
  return {
    title: titled.title,
    context_pack_ids: packs.ids,
    mcp_disabled: mcpOff,
    setup: {
      planner: answer.reason === null ? 'model' : 'fallback',
      fallback_reason: answer.reason ?? titled.problem,
      packs_linked: packs.linked,
      packs_unlinked: packs.unlinked,
      mcp_disabled: mcpOff,
      ms: answer.ms,
    },
  }
}
