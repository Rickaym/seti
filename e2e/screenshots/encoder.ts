import type { Browser, Page } from '@playwright/test'
import { framePhone, PHONE_PALETTES, STATUS_TIME } from './phone-frame.js'

const QUALITY = 0.82

/** The formats frames are kept in: WebP for the README, JPEG and PNG for the Play listing. */
export type ImageType = 'webp' | 'jpeg' | 'png'

/** Text antialiasing varies by a few pixels between runs; a frame changes past this share. */
const CHANGED_SHARE = 0.0005

/** Encodes and compares frames in a plain page, so no image tool is needed. */
export class Encoder {
  private readonly page: Page

  private constructor(page: Page) {
    this.page = page
  }

  static async open(browser: Browser): Promise<Encoder> {
    return new Encoder(await browser.newPage())
  }

  async encode(png: Buffer, type: ImageType): Promise<Buffer> {
    const encoded = await this.page.evaluate(
      async ([source, quality, mime]) => {
        const image = new Image()
        image.src = `data:image/png;base64,${source}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        canvas.getContext('2d')?.drawImage(image, 0, 0)
        return canvas.toDataURL(mime, quality).replace(/^data:[^,]*,/, '')
      },
      [png.toString('base64'), QUALITY, `image/${type}`] as const,
    )
    return Buffer.from(encoded, 'base64')
  }

  /** A phone capture inside a drawn phone of the theme's colours, as WebP with transparency. */
  async phone(png: Buffer, theme: keyof typeof PHONE_PALETTES): Promise<Buffer> {
    const args = [png.toString('base64'), QUALITY, PHONE_PALETTES[theme], STATUS_TIME] as const
    return Buffer.from(await this.page.evaluate(framePhone, args), 'base64')
  }

  /** Whether two frames of `type` differ in more than antialiasing noise. */
  async differs(before: Buffer, after: Buffer, type: ImageType): Promise<boolean> {
    return this.page.evaluate(
      async ([a, b, share, mime]) => {
        const pixels = async (source: string) => {
          const image = new Image()
          image.src = `data:${mime};base64,${source}`
          await image.decode()
          const canvas = document.createElement('canvas')
          canvas.width = image.naturalWidth
          canvas.height = image.naturalHeight
          const context = canvas.getContext('2d')
          context?.drawImage(image, 0, 0)
          return context?.getImageData(0, 0, canvas.width, canvas.height)
        }
        const [p, q] = [await pixels(a), await pixels(b)]
        if (p?.width !== q?.width || p?.height !== q?.height || p === undefined || q === undefined) {
          return true
        }
        let changed = 0
        for (let i = 0; i < p.data.length; i += 4) {
          const delta = [0, 1, 2].reduce((sum, c) => sum + Math.abs((p.data[i + c] ?? 0) - (q.data[i + c] ?? 0)), 0)
          changed += delta > 30 ? 1 : 0
        }
        return changed > p.width * p.height * share
      },
      [before.toString('base64'), after.toString('base64'), CHANGED_SHARE, `image/${type}`] as const,
    )
  }

  async close(): Promise<void> {
    await this.page.close()
  }
}
