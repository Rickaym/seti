import { extensionOf, languageOfPath, type CodeLanguage } from '@seti/shared'
import { escapeHtml, renderMarkdown } from '../share-markdown.js'
import { archivePreview, inflateHead, tarListing, zipListing } from './archive.js'
import { numberedText } from './code.js'
import { DATA_FORMATS, dataPreview } from './data.js'
import { CONVERTED_IMAGES, convertedImage, rasterPreview, rasterSize, rasterType } from './image.js'
import { MEDIA_EXTENSIONS } from './media-probe.js'
import { mediaPreview } from './media.js'
import { notebookPreview } from './notebook.js'
import { OFFICE_FORMATS, officePreview } from './office.js'
import { pdfPreview } from './pdf.js'
import {
  imageSlots,
  noteLine,
  plural,
  type ImageSlots,
  type PreviewImage,
  type PreviewInput,
  type RenderedPreview,
} from './preview.js'
import { svgPreview } from './svg.js'
import { tablePreview } from './table.js'

/** Larger Markdown shows as its source: rendering it would hold the server too long. */
const MARKDOWN_RENDER_MAX = 1024 * 1024
/** The most a stored page body may be; images are stored apart and load as the page scrolls. */
const PAGE_MAX = 4 * 1024 * 1024

/** Whether a file shows as rendered Markdown, which also decides whether its images are kept. */
export const rendersMarkdown = (kind: string, size: number) => kind === 'markdown' && size <= MARKDOWN_RENDER_MAX

/** A preview with what the share stores beside its page. */
export interface Preview extends RenderedPreview {
  images: PreviewImage[]
  /** The key image sources carry in the body; null when it shows no stored images. */
  imageKey: string | null
}

const NO_PREVIEW = '<p class="none">No preview for this file. Download it to open it.</p>'

const LANGUAGE_NAMES: Partial<Record<CodeLanguage, string>> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  jsx: 'JSX',
  tsx: 'TSX',
  json: 'JSON',
  yaml: 'YAML',
  sql: 'SQL',
  css: 'CSS',
  html: 'HTML',
  xml: 'XML',
  toml: 'TOML',
  ini: 'INI',
}

const languageName = (language: CodeLanguage) =>
  LANGUAGE_NAMES[language] ?? `${language[0]?.toUpperCase() ?? ''}${language.slice(1)}`

const isText = (input: PreviewInput) => input.mime.startsWith('text/plain')

const preview = (body: string, label: string, note: string | null = null): RenderedPreview => ({
  body,
  label,
  note,
  error: null,
  thumb: null,
})

/** Code highlighted, other text wrapped; both numbered. */
async function textPreview(input: PreviewInput): Promise<RenderedPreview> {
  const language = languageOfPath(input.name)
  const shown = await numberedText(input.content.toString('utf8'), language, language === null)
  const kind = language === null ? 'Text' : `${languageName(language)} code`
  return preview(noteLine(shown.note) + shown.html, `${kind}, ${plural(shown.lines, 'line')}`, shown.note)
}

async function archive(extension: string, name: string, content: Buffer): Promise<RenderedPreview | null> {
  if (extension === 'zip') {
    const listing = zipListing(content)
    return listing === null ? null : archivePreview('Zip', listing)
  }
  if (extension === 'tar') {
    const listing = tarListing(content)
    return listing === null ? null : archivePreview('Tar', listing)
  }
  if (!/\.(tgz|tar\.gz)$/i.test(name)) {
    return null
  }
  const inflated = await inflateHead(content)
  const cut = inflated?.whole === false ? 'listing stops at the first 64 MB unpacked' : null
  const listing = inflated === null ? null : tarListing(inflated.data, cut)
  return listing === null ? null : archivePreview('Tar', listing)
}

/** A Markdown file's images as stored images, by the link the file names each with. */
function markdownImages(input: PreviewInput, slots: ImageSlots): Map<string, string> {
  const sources = new Map<string, string>()
  for (const [link, image] of input.images) {
    const src = slots.add({ ...image, ...(rasterSize(image.bytes) ?? { width: 0, height: 0 }) })
    if (src !== null) {
      sources.set(link, src)
    }
  }
  return sources
}

/** Text formats by name: Markdown, tables, notebooks, data, and code or plain text. */
async function textByType(input: PreviewInput, extension: string, slots: ImageSlots) {
  if (rendersMarkdown(input.kind, input.content.length)) {
    const html = renderMarkdown(input.content.toString('utf8'), markdownImages(input, slots))
    return preview(`<article class="md">${html}</article>`, 'Markdown')
  }
  if (input.kind === 'csv') {
    return tablePreview(input.name, input.content)
  }
  if (extension === 'ipynb') {
    return notebookPreview(input.content, slots)
  }
  return DATA_FORMATS[extension] === undefined ? textPreview(input) : dataPreview(extension, input.content)
}

/** The renderer a file's name and bytes call for, or null for the plain fallback. */
async function byType(input: PreviewInput, slots: ImageSlots): Promise<RenderedPreview | null> {
  const extension = extensionOf(input.name)
  const raster = rasterType(input.content)
  if (input.kind === 'image' && raster !== null) {
    return rasterPreview(input.name, input.content, raster, slots)
  }
  const converted = CONVERTED_IMAGES[extension]
  if (converted !== undefined) {
    return convertedImage(input.name, input.content, converted, slots)
  }
  if (input.kind === 'pdf') {
    return pdfPreview(input.content, slots)
  }
  if (OFFICE_FORMATS[extension] !== undefined) {
    return officePreview(extension, input.content, slots)
  }
  if ((input.kind === 'audio' || input.kind === 'video') && MEDIA_EXTENSIONS.has(extension)) {
    const media = { name: input.name, extension, video: input.kind === 'video', bytes: input.content }
    return mediaPreview(media, slots)
  }
  if (extension === 'svg') {
    return svgPreview(input.name, input.content, slots)
  }
  if (['zip', 'tar', 'tgz', 'gz'].includes(extension)) {
    return archive(extension, input.name, input.content)
  }
  return isText(input) ? textByType(input, extension, slots) : null
}

/** What a failed renderer leaves: the source of a text file, else a pointer to the download. */
async function fallback(input: PreviewInput): Promise<RenderedPreview> {
  if (isText(input) && input.content.length <= PAGE_MAX / 2) {
    return textPreview(input)
  }
  return preview(
    NO_PREVIEW,
    input.kind === 'binary' ? 'File' : `${input.kind[0]?.toUpperCase() ?? ''}${input.kind.slice(1)}`,
  )
}

/** A file's page body and stored images, rendered once when it is shared or updated. */
export async function renderPreview(input: PreviewInput): Promise<Preview> {
  let slots = imageSlots()
  let rendered = await byType(input, slots)
  if (rendered === null || rendered.body === '' || rendered.body.length > PAGE_MAX) {
    const failed = await fallback(input)
    const label = rendered?.label ?? failed.label
    const tooLarge = rendered !== null && rendered.body.length > PAGE_MAX ? 'This file is too large to preview' : null
    rendered = { ...failed, label, error: rendered?.error ?? tooLarge, thumb: rendered?.thumb ?? null }
    slots = imageSlots()
  }
  const notice = rendered.error === null ? '' : `<p class="notice">${escapeHtml(rendered.error)}</p>`
  const used = rendered.body.includes(slots.key)
  return {
    ...rendered,
    body: notice + rendered.body,
    images: used ? slots.images : [],
    imageKey: used ? slots.key : null,
  }
}
