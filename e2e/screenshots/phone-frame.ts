/** Colours of a drawn phone body: its rim and the black glass around the screen. */
export interface PhonePalette {
  rim: string
  rimEdge: string
  glass: string
}

export const PHONE_PALETTES = {
  light: { rim: '#d4d4d9', rimEdge: '#b4b4bb', glass: '#0b0b0d' },
  dark: { rim: '#3a3a40', rimEdge: '#55555c', glass: '#000000' },
} as const satisfies Record<string, PhonePalette>

/** The clock the drawn status bar shows, the same moment the screenshots freeze at. */
export const STATUS_TIME = '14:42'

/**
 * Runs in the encoder page: draws a plain phone around a viewport capture, with a status bar and
 * home indicator in the page's own edge colours, on a transparent background, and returns WebP.
 */
export async function framePhone([source, quality, palette, time]: readonly [
  string,
  number,
  PhonePalette,
  string,
]): Promise<string> {
  const image = new Image()
  image.src = `data:image/png;base64,${source}`
  await image.decode()
  const s = image.naturalWidth / 393
  const [top, bottom, bezel, rim, margin] = [50 * s, 34 * s, 7 * s, 4 * s, 28 * s]
  const screen = { w: image.naturalWidth, h: image.naturalHeight + top + bottom }
  const body = { w: screen.w + 2 * (bezel + rim), h: screen.h + 2 * (bezel + rim) }
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(body.w + 2 * margin)
  canvas.height = Math.round(body.h + 2 * margin)
  const g = canvas.getContext('2d')
  if (g === null) {
    return ''
  }
  const rounded = ([x, y, w, h]: readonly [number, number, number, number], r: number) => {
    g.beginPath()
    g.roundRect(x, y, w, h, r)
  }
  const edge = (row: number) => {
    const probe = document.createElement('canvas')
    probe.width = 1
    probe.height = 1
    const p = probe.getContext('2d')
    p?.drawImage(image, 0, row, 1, 1, 0, 0, 1, 1)
    const [r = 0, gr = 0, b = 0] = p?.getImageData(0, 0, 1, 1).data ?? []
    return { css: `rgb(${String(r)}, ${String(gr)}, ${String(b)})`, dark: r * 0.3 + gr * 0.59 + b * 0.11 < 128 }
  }
  const [head, foot] = [edge(0), edge(image.naturalHeight - 1)]
  const radius = 48 * s
  g.save()
  g.shadowColor = 'rgba(0, 0, 0, 0.28)'
  g.shadowBlur = 18 * s
  g.shadowOffsetY = 6 * s
  g.fillStyle = palette.rimEdge
  rounded([margin, margin, body.w, body.h], radius + bezel + rim)
  g.fill()
  g.restore()
  g.fillStyle = palette.rim
  rounded([margin + s, margin + s, body.w - 2 * s, body.h - 2 * s], radius + bezel + rim - s)
  g.fill()
  g.fillStyle = palette.glass
  rounded([margin + rim, margin + rim, body.w - 2 * rim, body.h - 2 * rim], radius + bezel)
  g.fill()
  const [x, y] = [margin + rim + bezel, margin + rim + bezel]
  g.save()
  rounded([x, y, screen.w, screen.h], radius)
  g.clip()
  g.fillStyle = head.css
  g.fillRect(x, y, screen.w, top)
  g.fillStyle = foot.css
  g.fillRect(x, y + top + image.naturalHeight, screen.w, bottom)
  g.drawImage(image, x, y + top)
  g.restore()
  g.fillStyle = '#000000'
  rounded([x + screen.w / 2 - 60 * s, y + 11 * s, 120 * s, 34 * s], 17 * s)
  g.fill()
  g.fillStyle = head.dark ? '#ffffff' : '#000000'
  g.font = `600 ${String(16 * s)}px system-ui, sans-serif`
  g.textBaseline = 'middle'
  g.fillText(time, x + 32 * s, y + 28 * s)
  g.fillStyle = foot.dark ? 'rgba(255, 255, 255, 0.75)' : 'rgba(0, 0, 0, 0.8)'
  rounded([x + screen.w / 2 - 67 * s, y + screen.h - 13 * s, 134 * s, 5 * s], 2.5 * s)
  g.fill()
  return canvas.toDataURL('image/webp', quality).replace(/^data:image\/webp;base64,/, '')
}
