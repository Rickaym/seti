/** The diagram as a standalone SVG file: its natural size set, and no page-only width rules. */
export function standaloneSvg(svg: string, width: number, height: number): string {
  const element = new DOMParser().parseFromString(svg, 'text/html').body.querySelector('svg')
  if (element === null) {
    return svg
  }
  element.setAttribute('width', String(width))
  element.setAttribute('height', String(height))
  element.style.removeProperty('max-width')
  element.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  return new XMLSerializer().serializeToString(element)
}

export function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 0)
}

const PNG_SCALE = 2

/** A PNG of the standalone SVG at twice its size, on the theme's background. */
export async function pngOf(svg: string, width: number, height: number, background: string): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(width * PNG_SCALE)
    canvas.height = Math.ceil(height * PNG_SCALE)
    const context = canvas.getContext('2d')
    if (context === null) {
      throw new Error('This browser cannot draw a PNG')
    }
    context.fillStyle = background
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob === null) {
          reject(new Error('Could not encode the PNG'))
        } else {
          resolve(blob)
        }
      }, 'image/png')
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}
