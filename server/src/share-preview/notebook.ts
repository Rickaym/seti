import { languageOf, type CodeLanguage } from '@seti/shared'
import { escapeHtml, renderMarkdown } from '../share-markdown.js'
import { numberedText } from './code.js'
import { rasterSize, rasterType } from './image.js'
import { imageTag, plural, type ImageSlots, type PreviewImage, type RenderedPreview } from './preview.js'

/** Cells a notebook page shows; the rest are in the download. */
const CELLS_MAX = 500
/** Characters of one text output kept; long logs are cut. */
const OUTPUT_CHARS_MAX = 20_000
/** Bytes of one image output kept. */
const OUTPUT_IMAGE_MAX = 4 * 1024 * 1024
const MARKDOWN_MAX = 256 * 1024

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Notebook text is a string or a list of lines. */
function textOf(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  return Array.isArray(value) ? value.filter((line) => typeof line === 'string').join('') : ''
}

/** Terminal colour codes in tracebacks, which would show as noise. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

const clipText = (text: string) =>
  text.length > OUTPUT_CHARS_MAX ? `${text.slice(0, OUTPUT_CHARS_MAX)}\n[output cut]` : text

const outputText = (text: string, className = 'out') =>
  `<pre class="${className}">${escapeHtml(clipText(text.replace(ANSI, '')))}</pre>`

function languageOfNotebook(notebook: Json): CodeLanguage {
  const metadata = isObject(notebook.metadata) ? notebook.metadata : {}
  const info = isObject(metadata.language_info) ? metadata.language_info : {}
  const kernel = isObject(metadata.kernelspec) ? metadata.kernelspec : {}
  const name = typeof info.name === 'string' ? info.name : kernel.language
  return languageOf(typeof name === 'string' ? name : 'python') ?? 'python'
}

/** An image output, checked to be the raster type it claims by its bytes. */
function imageOutput(data: Json, slots: ImageSlots): string | null {
  for (const mime of ['image/png', 'image/jpeg']) {
    const encoded = textOf(data[mime]).replace(/\s/g, '')
    if (encoded === '' || encoded.length > (OUTPUT_IMAGE_MAX * 4) / 3) {
      continue
    }
    const bytes = Buffer.from(encoded, 'base64')
    const size = rasterSize(bytes)
    if (rasterType(bytes) !== mime || size === null) {
      continue
    }
    const image: PreviewImage = { mime, bytes, ...size }
    const src = slots.add(image)
    return src === null
      ? '<p class="none">[image left out: the share holds no more images]</p>'
      : imageTag(src, image, 'Output image', 'out')
  }
  return null
}

/** One output: images as images, text as escaped text, and HTML or anything else as its text. */
function outputHtml(output: Json, slots: ImageSlots): string {
  const kind = output.output_type
  if (kind === 'stream') {
    return outputText(textOf(output.text), output.name === 'stderr' ? 'out err' : 'out')
  }
  if (kind === 'error') {
    const trace = textOf(Array.isArray(output.traceback) ? output.traceback.map((line) => `${String(line)}\n`) : [])
    return outputText(trace === '' ? `${textOf(output.ename)}: ${textOf(output.evalue)}` : trace, 'out err')
  }
  const data = isObject(output.data) ? output.data : {}
  const image = imageOutput(data, slots)
  if (image !== null) {
    return image
  }
  if (data['text/plain'] !== undefined) {
    return outputText(textOf(data['text/plain']))
  }
  const [mime] = Object.keys(data)
  if (mime === undefined) {
    return ''
  }
  return `<p class="none">${escapeHtml(mime)} output, shown as text:</p>${outputText(textOf(data[mime]))}`
}

async function cellHtml(cell: Json, language: CodeLanguage, slots: ImageSlots): Promise<string> {
  const source = textOf(cell.source)
  if (cell.cell_type === 'markdown') {
    const markdown = source.length > MARKDOWN_MAX ? outputText(source, 'src') : renderMarkdown(source, new Map())
    return `<section class="cell md">${markdown}</section>`
  }
  if (cell.cell_type !== 'code') {
    return `<section class="cell">${outputText(source, 'src')}</section>`
  }
  const code = await numberedText(source, language, false)
  const outputs = Array.isArray(cell.outputs) ? cell.outputs.filter(isObject) : []
  const count = typeof cell.execution_count === 'number' ? `[${String(cell.execution_count)}]` : '[ ]'
  return [
    `<section class="cell code"><div class="prompt">${count}</div>`,
    code.html,
    outputs.map((output) => outputHtml(output, slots)).join(''),
    '</section>',
  ].join('')
}

/** A Jupyter notebook's cells in order; outputs are never live, whatever their type. */
export async function notebookPreview(content: Buffer, slots: ImageSlots): Promise<RenderedPreview | null> {
  let notebook: unknown
  try {
    notebook = JSON.parse(content.toString('utf8'))
  } catch {
    return null
  }
  if (!isObject(notebook) || !Array.isArray(notebook.cells)) {
    return null
  }
  const cells = notebook.cells.filter(isObject)
  const language = languageOfNotebook(notebook)
  const shown: string[] = []
  for (const cell of cells.slice(0, CELLS_MAX)) {
    shown.push(await cellHtml(cell, language, slots))
  }
  const note = cells.length > CELLS_MAX ? `first ${String(CELLS_MAX)} cells shown` : null
  const label = `Notebook, ${plural(cells.length, 'cell')}`
  return { body: `<div class="notebook">${shown.join('')}</div>`, label, note, error: null, thumb: null }
}
