import { runConverter, type ConverterLimits } from '../converter.js'
import { escapeHtml } from '../share-markdown.js'
import { rasterSize } from './image.js'
import { codecsOf, durationLabel, parseProbe, playsInBrowsers, type MediaProbe } from './media-probe.js'
import {
  converterError,
  imageTag,
  noteLine,
  type ImageSlots,
  type PreviewImage,
  type RenderedPreview,
} from './preview.js'

const MB = 1024 * 1024
/** As wide as a PDF page, so a poster reads on a phone and a desktop column alike. */
const POSTER_WIDTH = 1200
/** The poster comes from a tenth of the way in, at most this far, past any fade from black. */
const POSTER_AT_MAX = 5

const PROBE_LIMITS: ConverterLimits = {
  timeoutMs: 15_000,
  cpuSeconds: 15,
  memoryBytes: 512 * MB,
  fileBytes: MB,
  outputBytes: MB,
}
const POSTER_LIMITS: ConverterLimits = {
  timeoutMs: 30_000,
  cpuSeconds: 30,
  memoryBytes: 1024 * MB,
  fileBytes: 8 * MB,
  outputBytes: 8 * MB,
}

const ENTRIES =
  'format=format_name,duration:stream=codec_type,codec_name,width,height:' +
  'stream_disposition=attached_pic:stream_side_data=rotation:stream_tags=rotate'

async function probeMedia(extension: string, bytes: Buffer): Promise<MediaProbe | string> {
  const result = await runConverter({
    program: 'ffprobe',
    args: ['-v', 'error', '-show_entries', ENTRIES, '-of', 'json', `/in/input.${extension}`],
    inputs: new Map([[`input.${extension}`, bytes]]),
    limits: PROBE_LIMITS,
  })
  if (!result.ok) {
    return result.error
  }
  return parseProbe(result.stdout.toString('utf8')) ?? 'ffprobe gave no report'
}

const posterAt = (probe: MediaProbe) =>
  probe.cover || probe.duration === null ? 0 : Math.min(probe.duration / 10, POSTER_AT_MAX)

/** One frame, or an audio file's cover, as WebP no wider than a page; null when none comes out. */
async function poster(extension: string, bytes: Buffer, probe: MediaProbe): Promise<PreviewImage | null> {
  const result = await runConverter({
    program: 'ffmpeg',
    args: [
      ...['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1'],
      ...['-ss', posterAt(probe).toFixed(3), '-i', `/in/input.${extension}`],
      ...['-map', '0:v:0', '-frames:v', '1', '-vf', `scale='min(${String(POSTER_WIDTH)},iw)':-2`],
      ...['-c:v', 'libwebp', '-quality', '75', '/out/poster.webp'],
    ],
    inputs: new Map([[`input.${extension}`, bytes]]),
    limits: POSTER_LIMITS,
  })
  const image = result.ok ? result.files.get('poster.webp') : undefined
  const size = image === undefined ? null : rasterSize(image)
  return image === undefined || size === null ? null : { mime: 'image/webp', bytes: image, ...size }
}

/** "Video, 0:07, 1920 x 1080" or "Audio, 3:25". */
function mediaLabel(probe: MediaProbe): string {
  const parts = [probe.video === null ? 'Audio' : 'Video']
  if (probe.duration !== null) {
    parts.push(durationLabel(probe.duration))
  }
  if (probe.video !== null && probe.video.width > 0 && probe.video.height > 0) {
    parts.push(`${String(probe.video.width)} \u00d7 ${String(probe.video.height)}`)
  }
  return parts.join(', ')
}

const sizeAttrs = (image: PreviewImage | null) =>
  image === null ? '' : ` width="${String(image.width)}" height="${String(image.height)}"`

/** A native player with no script: the browser fetches the download in ranges as it plays. */
function player(name: string, probe: MediaProbe, still: { src: string; image: PreviewImage } | null, raw: string) {
  const label = ` aria-label="${escapeHtml(name)}"`
  const fallback = '<p class="none">This browser cannot play it. Download it to play.</p>'
  if (probe.video === null) {
    const cover = still === null ? '' : imageTag(still.src, still.image, `Cover of ${name}`, 'poster')
    return `${cover}<audio class="media" controls preload="metadata" src="${raw}"${label}>${fallback}</audio>`
  }
  const posterAttr = still === null ? '' : ` poster="${still.src}"`
  const attrs = `controls playsinline preload="metadata"${posterAttr}${sizeAttrs(still?.image ?? null)}`
  return `<video class="media" ${attrs} src="${raw}"${label}>${fallback}</video>`
}

/** What the page shows in place of a player: the poster, when there is one. */
const stillOnly = (name: string, still: { src: string; image: PreviewImage } | null) =>
  still === null ? '' : imageTag(still.src, still.image, `Poster of ${name}`, 'poster')

/** Audio or video: a native player when browsers play it, else its poster, length and download. */
export async function mediaPreview(
  input: { name: string; extension: string; video: boolean; bytes: Buffer },
  slots: ImageSlots,
): Promise<RenderedPreview> {
  const { name, extension, bytes } = input
  const found = await probeMedia(extension, bytes)
  if (typeof found === 'string') {
    const [label, subject] = input.video ? ['Video', 'This video'] : ['Audio', 'This audio']
    return { body: '', label, note: null, error: converterError(subject, found), thumb: null }
  }
  const image = found.video !== null || found.cover ? await poster(extension, bytes, found) : null
  const src = image === null ? null : slots.add(image)
  const still = image === null || src === null ? null : { src, image }
  const label = mediaLabel(found)
  const plays = playsInBrowsers(extension, found)
  const note = plays ? null : `download to play: browsers do not play ${extension.toUpperCase()} (${codecsOf(found)})`
  const shown = plays ? player(name, found, still, slots.raw) : stillOnly(name, still)
  const caption = `<p class="caption">${escapeHtml(label)}</p>${noteLine(note)}`
  return { body: `${caption}<div class="player">${shown}</div>`, label, note, error: null, thumb: image }
}
