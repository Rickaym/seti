import type { AgentCapabilities, RuntimeCapabilities, Task } from '@seti/shared'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'

export const capabilitiesResource = createPolledResource<RuntimeCapabilities>('/runtimes/capabilities', 300_000)

/** What the agent's runtime can do, as its adapter declares it; null while loading. */
export function useCapabilities(task: Pick<Task, 'runtime'>): AgentCapabilities | null {
  const { data } = usePolled(capabilitiesResource)
  return data?.[task.runtime] ?? null
}
