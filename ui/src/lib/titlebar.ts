/** Chrome's Window Controls Overlay, which TypeScript's DOM types do not describe yet. */
interface ControlsOverlay extends EventTarget {
  readonly visible: boolean
  getTitlebarAreaRect(): DOMRect
}

declare global {
  interface Navigator {
    readonly windowControlsOverlay?: ControlsOverlay
  }
}

/** The strip beside the OS window buttons that an installed app draws into, in CSS pixels. */
interface TitlebarArea {
  x: number
  y: number
  width: number
  height: number
}

/** The title bar area while the overlay shows, or null while the OS draws its own title bar. */
export function titlebarArea(overlay: { visible: boolean; getTitlebarAreaRect(): TitlebarArea } | undefined) {
  if (overlay?.visible !== true) {
    return null
  }
  const { x, y, width, height } = overlay.getTitlebarAreaRect()
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

/** Custom properties that stand in for `env(titlebar-area-*)` where the browser leaves it unset. */
export function titlebarVars(area: TitlebarArea): Record<string, string> {
  return {
    '--titlebar-area-x': `${String(area.x)}px`,
    '--titlebar-area-y': `${String(area.y)}px`,
    '--titlebar-area-width': `${String(area.width)}px`,
    '--titlebar-area-height': `${String(area.height)}px`,
  }
}
