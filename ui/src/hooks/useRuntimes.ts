import type { RuntimesStatus } from '@seti/shared'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'

const runtimesResource = createPolledResource<RuntimesStatus>('/runtimes', 15_000)

/** Where each runtime besides Claude Code stands, such as whether Codex is ready. */
export function useRuntimes() {
  return usePolled(runtimesResource)
}

/** Polls the runtimes now, as after the user changes a runtime's settings. */
export function refreshRuntimes(): void {
  runtimesResource.refresh()
}

/** Whether a new agent may run on Codex now, which the start page offers only then. */
export function useCodexReady(): boolean {
  return useRuntimes().data?.codex.state === 'ready'
}
