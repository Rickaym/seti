import { useEffect, useRef } from 'react'
import { readPalette } from './palette'
import { WeatherRenderer } from './renderer'
import type { WeatherScene } from './scene'

/** The weather layer of the daylight band: clouds, rain, snow, fog, lightning and shooting stars. */
export function WeatherSky({ scene }: { scene: WeatherScene }) {
  const back = useRef<HTMLCanvasElement>(null)
  const ref = useRef<HTMLCanvasElement>(null)
  const front = useRef<HTMLCanvasElement>(null)
  const renderer = useRef<WeatherRenderer | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !back.current || !front.current) {
      return undefined
    }
    const current = new WeatherRenderer({ back: back.current, main: canvas, front: front.current })
    renderer.current = current
    const readColours = () => {
      current.setPalette(readPalette(canvas))
    }
    readColours()
    const theme = new MutationObserver(readColours)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    const onVisibility = () => {
      current.setPageVisible(document.visibilityState === 'visible')
    }
    document.addEventListener('visibilitychange', onVisibility)
    const view = new IntersectionObserver(([entry]) => {
      current.setOnscreen(entry?.isIntersecting ?? true)
    })
    view.observe(canvas)
    return () => {
      theme.disconnect()
      view.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      current.destroy()
      renderer.current = null
    }
  }, [])

  useEffect(() => {
    renderer.current?.setScene(scene)
  }, [scene])

  const layer = 'pointer-events-none absolute inset-0 size-full'
  return (
    <>
      <canvas ref={back} aria-hidden className={layer} />
      <canvas ref={ref} aria-hidden className={layer} />
      <canvas ref={front} aria-hidden className={layer} />
    </>
  )
}
