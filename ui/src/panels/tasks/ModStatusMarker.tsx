import type { ModStatusMarkerProps } from '@seti/mod-api'
import { Component, useSyncExternalStore, type ReactNode } from 'react'
import { agentColorAttr } from '@/lib/agent-color-sheet'
import { statusMarkers } from '@/lib/status-markers'

interface BoundaryProps {
  fallback: ReactNode
  children: ReactNode
}

/** A marker that throws gives way to Seti's own shape, so a row never loses its status. */
export class MarkerBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override render() {
    return <>{this.state.failed ? this.props.fallback : this.props.children}</>
  }
}

/**
 * The status marker an enabled mod draws in place of Seti's shape, or the shape with none. A
 * view that draws nothing leaves its span empty, and CSS shows Seti's shape after it instead.
 */
export function ModStatusMarker({ fallback, ...props }: ModStatusMarkerProps & { fallback: ReactNode }) {
  const [marker] = useSyncExternalStore(statusMarkers.subscribe, statusMarkers.list, statusMarkers.list)
  if (marker === undefined) {
    return <>{fallback}</>
  }
  const View = marker.view
  return (
    <MarkerBoundary key={marker.key} fallback={fallback}>
      <span className="contents" data-mod-marker="" {...agentColorAttr(props.agent?.color ?? null)}>
        <View {...props} />
      </span>
      <span className="contents" data-marker-fallback="">
        {fallback}
      </span>
    </MarkerBoundary>
  )
}
