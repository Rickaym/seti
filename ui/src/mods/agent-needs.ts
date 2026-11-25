import { meetsNeeds, type AgentCapabilityName, type RuntimeCapabilities, type TaskListEntry } from '@seti/shared'
import { useCallback } from 'react'
import { capabilitiesResource } from '@/hooks/useCapabilities'
import { usePolled } from '@/hooks/usePolled'
import { tasksResource } from '@/hooks/useTasks'

type Needs = readonly AgentCapabilityName[]

/** The runtime's name when the agent's runtime lacks what a mod's command or view needs. */
export type AgentLacks = (agent: string | null, needs: Needs) => string | null

function lacking(
  tasks: readonly TaskListEntry[] | undefined,
  caps: RuntimeCapabilities | undefined,
  agent: string | null,
  needs: Needs,
): string | null {
  if (needs.length === 0 || agent === null) {
    return null
  }
  const runtime = tasks?.find((task) => task.id === agent)?.runtime
  const ofRuntime = runtime === undefined ? null : (caps?.[runtime] ?? null)
  return ofRuntime === null || meetsNeeds(ofRuntime, needs) ? null : ofRuntime.label
}

/**
 * The runtime's name when the agent's runtime lacks what `needs` names, as its adapter declares
 * it; null for no agent, and while the agent or its capabilities are unknown.
 */
export const agentLacks: AgentLacks = (agent, needs) =>
  lacking(tasksResource.getSnapshot().data, capabilitiesResource.getSnapshot().data, agent, needs)

/** agentLacks for a component, which renders again when agents or capabilities change. */
export function useAgentLacks(): AgentLacks {
  const tasks = usePolled(tasksResource).data
  const caps = usePolled(capabilitiesResource).data
  return useCallback<AgentLacks>((agent, needs) => lacking(tasks, caps, agent, needs), [tasks, caps])
}
