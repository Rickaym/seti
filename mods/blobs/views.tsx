import type { ModAgentAccentProps, ModStatusMarkerProps } from '@seti/mod-api'
import type { ComponentType } from 'react'
import { BlobFigure } from './Blob'
import { showsIn, type BlobSettings } from './look'

type UseSettings = () => BlobSettings

/** The mod's two views, reading its settings live through the hook the mod API hands it. */
export function blobViews(useSettings: UseSettings): {
  Blob: ComponentType<ModStatusMarkerProps>
  BlobBookmark: ComponentType<ModAgentAccentProps>
} {
  /**
   * An agent's status as a small blob in its colour; Seti keeps the name and tooltip. List rows
   * carry the bookmark instead, so their marker keeps Seti's shape.
   */
  function Blob({ status, agent, place }: ModStatusMarkerProps) {
    const settings = useSettings()
    if (place === 'list' || place === 'needsYou' || !showsIn(settings, place)) {
      return null
    }
    return <BlobFigure status={status} agent={agent} settings={settings} bookmark={false} />
  }

  /**
   * The blob as a bookmark on an agent row's left edge, in place of its colour bar. Where blobs
   * are off it leaves a blank of the same width, so titles line up and Seti keeps the bar.
   */
  function BlobBookmark({ status, agent, place }: ModAgentAccentProps) {
    const settings = useSettings()
    if (!showsIn(settings, place)) {
      return <span className="seti-blob-blank" data-blob-size={settings.size} data-accent-blank="" />
    }
    return <BlobFigure status={status} agent={agent} settings={settings} bookmark />
  }

  return { Blob, BlobBookmark }
}
