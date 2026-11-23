import type { CpuCap, CpuScope, MemoryCap, MemoryScope } from '@seti/shared'
import { controlLink } from './node-link.js'

/** The scopes holding the agent's processes, as its node reads them. */
export async function agentScopes(agent: string): Promise<{ memory: MemoryScope[]; cpu: CpuScope[] }> {
  return controlLink.command('scopes.read', { agent })
}

async function capsOf<T>(capOf: (agent: string) => Promise<T | null>): Promise<{ agent: string; cap: T }[]> {
  const { agents } = await controlLink.command('scopes.agents', {})
  const caps = await Promise.all(agents.map(async (agent) => ({ agent, cap: await capOf(agent) })))
  return caps.flatMap(({ agent, cap }) => (cap === null ? [] : [{ agent, cap }]))
}

/** Moves the live scopes of the agents `capOf` covers to their memory cap; null leaves one alone. */
export async function capMemoryScopes(capOf: (agent: string) => Promise<MemoryCap | null>): Promise<void> {
  await controlLink.command('scopes.cap', { memory: await capsOf(capOf), cpu: [] })
}

/** Moves the live scopes of the agents `capOf` covers to their CPU cap; null leaves one alone. */
export async function capCpuScopes(capOf: (agent: string) => Promise<CpuCap | null>): Promise<void> {
  await controlLink.command('scopes.cap', { memory: [], cpu: await capsOf(capOf) })
}
