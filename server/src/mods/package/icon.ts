import { MOD_PACKAGE_LIMITS } from '@seti/shared'
import { html, parseFragment, type DefaultTreeAdapterTypes } from 'parse5'
import { textOf } from './files.js'

type Node = DefaultTreeAdapterTypes.ChildNode
type Element = DefaultTreeAdapterTypes.Element

const SVG_NS = html.NS.SVG

/** Shapes, paint and grouping: nothing that loads, links, scripts, animates or embeds. */
const ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'title',
  'desc',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
])

const DRAWING = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'])

const ATTRIBUTES = new Set([
  'id',
  'viewBox',
  'width',
  'height',
  'preserveAspectRatio',
  'version',
  'd',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'points',
  'transform',
  'opacity',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'clip-path',
  'clip-rule',
  'mask',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
  'clipPathUnits',
  'maskUnits',
  'maskContentUnits',
])

const MAX_ELEMENTS = 2000
const MAX_VALUE = 20_000

/** A value with no reference out of the image: url() only to an id inside it. */
const safeValue = (value: string) =>
  value.length <= MAX_VALUE &&
  [...value.matchAll(/url\s*\(([^)]*)\)/gi)].every((m) => /^\s*#[\w-]+\s*$/.test(m[1] ?? ''))

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The tag of every element kept, in order. */
type Walk = string[]

function serialize(node: Node, walk: Walk, inText: boolean): string {
  if (node.nodeName === '#text' && 'value' in node) {
    return inText ? escape(node.value) : ''
  }
  if (!('tagName' in node) || node.namespaceURI !== SVG_NS || !ELEMENTS.has(node.tagName)) {
    return ''
  }
  walk.push(node.tagName)
  const attrs = node.attrs
    .filter((attr) => attr.namespace === undefined && ATTRIBUTES.has(attr.name) && safeValue(attr.value))
    .map((attr) => ` ${attr.name}="${escape(attr.value)}"`)
  const xmlns = node.tagName === 'svg' ? ` xmlns="${SVG_NS}"` : ''
  const text = node.tagName === 'title' || node.tagName === 'desc'
  const children = node.childNodes.map((child) => serialize(child, walk, text)).join('')
  return `<${node.tagName}${xmlns}${attrs.join('')}>${children}</${node.tagName}>`
}

/** An SVG rebuilt from its shapes alone, or why it cannot be an icon. */
export function sanitizeSvg(file: string, source: string): { svg: string } | { problem: string } {
  const roots = parseFragment(source).childNodes.filter((node): node is Element => 'tagName' in node)
  const [root] = roots
  if (roots.length !== 1 || root?.tagName !== 'svg' || root.namespaceURI !== SVG_NS) {
    return { problem: `${file} is not one <svg> image` }
  }
  const walk: Walk = []
  const svg = serialize(root, walk, false)
  if (walk.length > MAX_ELEMENTS) {
    return { problem: `${file} has more than ${String(MAX_ELEMENTS)} elements` }
  }
  return walk.some((tag) => DRAWING.has(tag)) ? { svg } : { problem: `${file} draws no shapes Seti keeps` }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Why a PNG cannot be an icon: not a PNG, or larger than the icon size. */
function pngProblem(file: string, bytes: Buffer): string | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('latin1', 12, 16) !== 'IHDR') {
    return `${file} is not a PNG image`
  }
  const [width, height] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
  const max = MOD_PACKAGE_LIMITS.iconPixels
  return width === 0 || height === 0 || width > max || height > max
    ? `${file} is ${String(width)} by ${String(height)} pixels; an icon is at most ${String(max)} by ${String(max)}`
    : null
}

/** The icon as a data URL the UI shows in an <img>, or why the file cannot be an icon. */
export function iconData(file: string, bytes: Buffer): { url: string } | { problem: string } {
  if (file.toLowerCase().endsWith('.png')) {
    const problem = pngProblem(file, bytes)
    return problem === null ? { url: `data:image/png;base64,${bytes.toString('base64')}` } : { problem }
  }
  const text = textOf(bytes)
  if (text === null) {
    return { problem: `${file} is not UTF-8 text` }
  }
  const clean = sanitizeSvg(file, text)
  return 'problem' in clean
    ? clean
    : { url: `data:image/svg+xml;base64,${Buffer.from(clean.svg, 'utf8').toString('base64')}` }
}
