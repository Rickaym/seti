import {
  kindByName,
  SHARE_DIAGRAM_SOURCE_MAX,
  SHARE_DIAGRAM_SVG_MAX,
  SHARE_DIAGRAMS_BYTES_MAX,
  SHARE_DIAGRAMS_MAX,
  type ShareDiagramInput,
} from '@seti/shared'
import { fenceRenderers, rendererFor } from '@/lib/fence-renderers'
import { fetchRaw, rawUrl } from './files-api'

/** The file a share is made of, as the share dialog names it. */
export interface DiagramTarget {
  taskId: string
  root: string
  path: string
  name: string
}

/** Larger Markdown shows as its source on the share page, so its fences are never drawn. */
const MARKDOWN_MAX = 1024 * 1024

interface Fence {
  language: string
  source: string
}

/** The fences a share draws: a Markdown file's fenced blocks, or a file that is one diagram. */
async function fencesOf(target: DiagramTarget, signal: AbortSignal): Promise<Fence[]> {
  const kind = kindByName(target.name)
  const whole = kind !== null && (rendererFor(kind)?.snapshot ?? null) !== null
  if (kind !== 'markdown' && !whole) {
    return []
  }
  const dotfiles = target.path.split('/').some((part) => part.startsWith('.'))
  const text = await (await fetchRaw(rawUrl(target.taskId, target, { dotfiles }), signal)).text()
  if (whole) {
    return [{ language: kind, source: text }]
  }
  if (text.length > MARKDOWN_MAX) {
    return []
  }
  const { markdownFences } = await import('@seti/shared/markdown-fences')
  return markdownFences(text)
}

async function drawFence(fence: Fence): Promise<ShareDiagramInput | null> {
  const snapshot = rendererFor(fence.language)?.snapshot ?? null
  if (snapshot === null || fence.source === '' || fence.source.length > SHARE_DIAGRAM_SOURCE_MAX) {
    return null
  }
  const [light, dark] = [await snapshot(fence.source, 'light'), await snapshot(fence.source, 'dark')]
  if (light === null || dark === null || light.length > SHARE_DIAGRAM_SVG_MAX || dark.length > SHARE_DIAGRAM_SVG_MAX) {
    return null
  }
  return { language: fence.language, source: fence.source, light, dark }
}

/**
 * Draws the file's fences that an enabled mod can draw for a share page, light and dark, so the
 * page shows them as images. A fence that fails, or a file Seti cannot read, leaves the share
 * as code.
 */
export async function shareDiagrams(target: DiagramTarget, signal: AbortSignal): Promise<ShareDiagramInput[]> {
  if (!fenceRenderers.list().some((entry) => entry.snapshot !== null)) {
    return []
  }
  try {
    const seen = new Set<string>()
    const drawn: ShareDiagramInput[] = []
    let bytes = 0
    for (const fence of await fencesOf(target, signal)) {
      const key = `${fence.language}\n${fence.source}`
      if (drawn.length >= SHARE_DIAGRAMS_MAX || seen.has(key)) {
        continue
      }
      seen.add(key)
      const diagram = await drawFence(fence)
      const size = diagram === null ? 0 : diagram.light.length + diagram.dark.length
      if (diagram !== null && bytes + size <= SHARE_DIAGRAMS_BYTES_MAX) {
        drawn.push(diagram)
        bytes += size
      }
    }
    return drawn
  } catch {
    return []
  }
}
