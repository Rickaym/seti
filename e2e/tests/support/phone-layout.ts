import type { Locator, Page } from '@playwright/test'
import { expect } from './fixtures.js'

/** Phones get label sizes a step up; nothing with text may render smaller than this. */
const MIN_FONT_PX = 11

interface Probe {
  minFont: number
  /** Elements, and everything inside them, that may sit past the viewport on purpose. */
  ignore: string
}

/** Runs in the page: each element past the viewport after clipping, and each too-small text. */
function layoutProblems({ minFont, ignore }: Probe): string[] {
  const width = document.documentElement.clientWidth
  const name = (el: Element) => {
    const label = el.getAttribute('aria-label') ?? el.getAttribute('data-slot')
    const tag = label === null ? el.tagName.toLowerCase() : `${el.tagName.toLowerCase()} ${label}`
    return `<${tag}> "${el.textContent.trim().slice(0, 40)}"`
  }
  /** The horizontal span an element can paint in, narrowed by each ancestor that clips it. */
  const visibleSpan = (el: Element): [number, number] => {
    const box = el.getBoundingClientRect()
    let [left, right] = [box.left, box.right]
    for (let node = el.parentElement; node !== null && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.position === 'fixed') {
        break
      }
      if (style.overflowX !== 'visible') {
        const clip = node.getBoundingClientRect()
        left = Math.max(left, clip.left)
        right = Math.min(right, clip.right)
      }
    }
    return [left, right]
  }
  const shown = (el: Element) => {
    const box = el.getBoundingClientRect()
    return (
      box.width >= 2 &&
      box.height >= 2 &&
      el.closest(ignore) === null &&
      el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    )
  }
  const hasText = (el: Element) =>
    Array.from(el.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim() !== '')

  const problems: string[] = []
  if (document.documentElement.scrollWidth > width) {
    problems.push(`page scrolls sideways: ${String(document.documentElement.scrollWidth)} > ${String(width)}`)
  }
  const outside = new Set<Element>()
  for (const el of Array.from(document.body.querySelectorAll('*')).filter(shown)) {
    const [left, right] = visibleSpan(el)
    if (right > left && (left < -1 || right > width + 1)) {
      outside.add(el)
      if (el.parentElement === null || !outside.has(el.parentElement)) {
        problems.push(`past the viewport (${String(Math.round(left))}..${String(Math.round(right))}): ${name(el)}`)
      }
    }
    const size = parseFloat(getComputedStyle(el).fontSize)
    if (size < minFont && hasText(el)) {
      problems.push(`text at ${String(size)}px: ${name(el)}`)
    }
  }
  return problems
}

/** Waits for fonts and every finite animation, so boxes read where they rest. */
export const settled = async (page: Page) =>
  page.evaluate(async () => {
    await document.fonts.ready
    const finite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
    await Promise.all(finite.map(async (animation) => animation.finished.catch(() => undefined)))
  })

interface Edges {
  top: number
  bottom: number
  height: number
}

/** Where `locator` sits once its open animation ends, rounded to whole pixels. */
export async function edgesAtRest(page: Page, locator: Locator): Promise<Edges> {
  await settled(page)
  const box = await locator.boundingBox()
  expect(box, 'bounding box').not.toBeNull()
  const { y = 0, height = 0 } = box ?? {}
  return { top: Math.round(y), bottom: Math.round(y + height), height: Math.round(height) }
}

/** Nothing scrolls the page sideways or pokes past its edges, and all text is readable. */
export async function expectFitsPhone(page: Page, where: string, ignore: readonly string[] = []): Promise<void> {
  await settled(page)
  const probe: Probe = { minFont: MIN_FONT_PX, ignore: ['[aria-hidden="true"]', ...ignore].join(',') }
  expect(await page.evaluate(layoutProblems, probe), where).toEqual([])
}
