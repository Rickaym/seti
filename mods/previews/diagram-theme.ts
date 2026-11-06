import type { ModViewTheme } from '@seti/mod-api'
import { useMemo } from 'react'
import type { DiagramTheme } from './diagram-render'

let probe: CanvasRenderingContext2D | null = null

/** Any CSS colour, oklch included, as the hex Mermaid's colour maths understands. */
function rgbOf(color: string): string {
  if (probe === null) {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    probe = canvas.getContext('2d', { willReadFrequently: true })
  }
  if (probe === null) {
    return color
  }
  probe.clearRect(0, 0, 1, 1)
  probe.fillStyle = color
  probe.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0, a = 255] = probe.getImageData(0, 0, 1, 1).data
  const channels = a === 255 ? [r, g, b] : [r, g, b, a]
  return `#${channels.map((n) => n.toString(16).padStart(2, '0')).join('')}`
}

function readTheme(key: string, dark: boolean): DiagramTheme {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string) => rgbOf(style.getPropertyValue(`--${name}`).trim())
  const background = token('background')
  const foreground = token('foreground')
  const fill = token('accent')
  const line = token('muted-foreground')
  const border = token('border')
  const muted = token('muted')
  const primary = token('primary')
  return {
    key,
    background,
    dark,
    font: getComputedStyle(document.body).fontFamily,
    variables: {
      background,
      primaryColor: fill,
      primaryTextColor: foreground,
      primaryBorderColor: primary,
      secondaryColor: muted,
      secondaryTextColor: foreground,
      secondaryBorderColor: border,
      tertiaryColor: token('card'),
      tertiaryTextColor: foreground,
      tertiaryBorderColor: border,
      mainBkg: fill,
      nodeBorder: primary,
      textColor: foreground,
      titleColor: foreground,
      lineColor: line,
      clusterBkg: muted,
      clusterBorder: border,
      edgeLabelBackground: background,
      noteBkgColor: muted,
      noteTextColor: foreground,
      noteBorderColor: border,
      actorBkg: fill,
      actorBorder: primary,
      actorTextColor: foreground,
      signalColor: foreground,
      signalTextColor: foreground,
      labelBoxBkgColor: muted,
      labelTextColor: foreground,
      sequenceNumberColor: background,
    },
  }
}

/** Seti's theme as diagram colours, read again from its tokens whenever the theme changes. */
export function useDiagramTheme({ key, dark }: ModViewTheme): DiagramTheme {
  return useMemo(() => readTheme(key, dark), [key, dark])
}
