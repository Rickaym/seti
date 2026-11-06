import type { ModFenceProps } from '@seti/mod-api'
import { Registry } from '@seti/shared'
import { useSyncExternalStore, type ComponentType } from 'react'

/** What draws Markdown fences of one language: the enabled mod that declares it. */
export interface FenceRendererEntry {
  language: string
  view: ComponentType<ModFenceProps>
}

export const fenceRenderers = new Registry<FenceRendererEntry>('fence renderer', (entry) => entry.language)

/** The renderer of a fence language; undefined for plain code. */
export function rendererFor(
  language: string | null,
  renderers: readonly FenceRendererEntry[] = fenceRenderers.list(),
): FenceRendererEntry | undefined {
  return renderers.find((entry) => entry.language === language)
}

/** The renderer of a fence language, following mods as they turn on and off. */
export function useFenceRenderer(language: string | null): FenceRendererEntry | undefined {
  return rendererFor(language, useSyncExternalStore(fenceRenderers.subscribe, fenceRenderers.list))
}
