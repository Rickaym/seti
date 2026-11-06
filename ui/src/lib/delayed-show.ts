interface DelayedShowTiming {
  /** How long loading must last before the indicator shows. */
  delayMs: number
  /** How long the indicator stays once shown, however soon loading ends. */
  minShownMs: number
}

interface DelayedShow {
  /** Reports whether the thing the indicator stands for is still loading. */
  set: (active: boolean) => void
  /** Reports the indicator reached the screen; its minimum time counts from here. */
  displayed: () => void
  dispose: () => void
}

/** Skips loads quicker than `delayMs`, then stays at least `minShownMs` so it never flickers. */
export function createDelayedShow(
  { delayMs, minShownMs }: DelayedShowTiming,
  onChange: (shown: boolean) => void,
): DelayedShow {
  let shownAt: number | null = null
  let showing = false
  let showTimer: ReturnType<typeof setTimeout> | undefined
  let hideTimer: ReturnType<typeof setTimeout> | undefined

  const hide = () => {
    hideTimer = undefined
    shownAt = null
    onChange(false)
  }

  return {
    set: (active) => {
      if (active) {
        clearTimeout(hideTimer)
        hideTimer = undefined
        if (shownAt === null && !showing && showTimer === undefined) {
          showTimer = setTimeout(() => {
            showTimer = undefined
            showing = true
            onChange(true)
          }, delayMs)
        }
        return
      }
      clearTimeout(showTimer)
      showTimer = undefined
      if (showing) {
        // Loading ended before the indicator reached the screen, so it never shows.
        showing = false
        onChange(false)
        return
      }
      if (shownAt === null || hideTimer !== undefined) {
        return
      }
      const left = minShownMs - (Date.now() - shownAt)
      if (left <= 0) {
        hide()
      } else {
        hideTimer = setTimeout(hide, left)
      }
    },
    displayed: () => {
      if (showing) {
        showing = false
        shownAt = Date.now()
      }
    },
    dispose: () => {
      clearTimeout(showTimer)
      clearTimeout(hideTimer)
    },
  }
}
