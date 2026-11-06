import type { ModAgentViewProps } from '@seti/mod-api'
import { lazy, Suspense } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary'

const AgentView = lazy(async () => import('@/panels/tasks/AgentView').then((m) => ({ default: m.AgentView })))

/** One agent or subagent behind an error boundary, loaded with the agent page's code. */
export function GuardedAgentView(props: ModAgentViewProps) {
  return (
    <ErrorBoundary name="This agent" resetKey={`${props.task.id}/${props.subId ?? ''}`}>
      <Suspense>
        <AgentView {...props} />
      </Suspense>
    </ErrorBoundary>
  )
}
