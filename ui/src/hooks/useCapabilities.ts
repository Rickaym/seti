import {
  STORED_RUNTIMES,
  type AgentCapabilities,
  type RuntimeCapabilities,
  type StoredRuntime,
  type Task,
} from '@seti/shared'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'

export const capabilitiesResource = createPolledResource<RuntimeCapabilities>('/runtimes/capabilities', 300_000)

/** What the agent's runtime can do, as its adapter declares it; null while loading. */
export function useCapabilities(task: Pick<Task, 'runtime'>): AgentCapabilities | null {
  const { data } = usePolled(capabilitiesResource)
  return data?.[task.runtime] ?? null
}

/** The runtimes whose agents can use what `can` asks of a runtime; undefined while loading. */
export function useRuntimesThat(can: (caps: AgentCapabilities) => boolean): StoredRuntime[] | undefined {
  const { data } = usePolled(capabilitiesResource)
  return data === undefined ? undefined : STORED_RUNTIMES.filter((runtime) => can(data[runtime]))
}
