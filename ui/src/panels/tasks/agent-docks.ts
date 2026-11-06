import type { ModDockProps, ModIcon } from '@seti/mod-api'
import { Registry } from '@seti/shared'
import { useEffect, useSyncExternalStore, type ComponentType } from 'react'

/** A dock a mod places over agents' chats: a panel on wide screens, a bottom sheet on a phone. */
export interface AgentDock {
  /** `<mod>.<dock>`. */
  key: string
  title: string
  /** The short line beside the title, or null. */
  description: string | null
  icon: ModIcon
  view: ComponentType<ModDockProps>
  /** Runs when the dock closes over an agent, or the agent's view goes away. */
  onClose: ((agent: string) => void) | null
}

export const agentDocks = new Registry<AgentDock>('agent dock', (dock) => dock.key)

/** The dock open over one agent, and how often it was opened since, so its view can take focus. */
interface OpenDock {
  key: string
  focus: number
}

const opened = new Map<string, OpenDock>()
const hosts = new Map<string, number>()
const listeners = new Set<() => void>()

const notify = () => {
  for (const listener of listeners) {
    listener()
  }
}

/** Closes the dock open over the agent, the given one only when a key is given. */
export function closeAgentDock(agent: string, key?: string): void {
  const open = opened.get(agent)
  if (open === undefined || (key !== undefined && open.key !== key)) {
    return
  }
  opened.delete(agent)
  notify()
  agentDocks.get(open.key)?.onClose?.(agent)
}

/** Opens a dock over the agent's chat, in place of another; opening it again refocuses it. */
export function openAgentDock(agent: string, key: string): void {
  if (!agentDocks.has(key)) {
    return
  }
  const open = opened.get(agent)
  if (open !== undefined && open.key !== key) {
    closeAgentDock(agent)
  }
  opened.set(agent, { key, focus: open?.key === key ? open.focus + 1 : 1 })
  notify()
}

agentDocks.subscribe(() => {
  const gone = [...opened].filter(([, open]) => !agentDocks.has(open.key))
  for (const [agent] of gone) {
    opened.delete(agent)
  }
  if (gone.length > 0) {
    notify()
  }
})

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The dock open over the agent with its view, or null; its frames keep it open while shown. */
export function useAgentDock(agent: string): { dock: AgentDock; focus: number } | null {
  const open = useSyncExternalStore(subscribe, () => opened.get(agent))
  useEffect(() => {
    hosts.set(agent, (hosts.get(agent) ?? 0) + 1)
    return () => {
      const left = (hosts.get(agent) ?? 1) - 1
      if (left > 0) {
        hosts.set(agent, left)
        return
      }
      hosts.delete(agent)
      closeAgentDock(agent)
    }
  }, [agent])
  const dock = open === undefined ? undefined : agentDocks.get(open.key)
  return open === undefined || dock === undefined ? null : { dock, focus: open.focus }
}
