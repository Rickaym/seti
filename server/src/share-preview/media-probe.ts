import { z } from 'zod'

/** What ffprobe found in a media file: its container, length, and first video and audio streams. */
export interface MediaProbe {
  /** ffprobe's format names, such as ["mov", "mp4", "m4a"]. */
  containers: string[]
  /** Seconds, or null when the file does not say. */
  duration: number | null
  video: { codec: string; width: number; height: number } | null
  audio: string | null
  /** A still picture stored with audio, such as an MP3's cover. */
  cover: boolean
}

/** A length past a thousand days is a corrupt header, not a recording. */
const DURATION_MAX = 1000 * 86_400

const dimension = z.number().int().min(0).max(65_536).optional()

const stream = z.object({
  codec_type: z.string().max(32).optional(),
  codec_name: z.string().max(64).optional(),
  width: dimension,
  height: dimension,
  disposition: z.object({ attached_pic: z.number().optional() }).optional(),
  side_data_list: z
    .array(z.object({ rotation: z.number().optional() }).loose())
    .max(64)
    .optional(),
  tags: z
    .object({ rotate: z.string().max(16).optional() })
    .loose()
    .optional(),
})

const report = z.object({
  streams: z.array(stream.loose()).max(1024).default([]),
  format: z.object({ format_name: z.string().max(256), duration: z.string().max(64).optional() }).loose(),
})

type Stream = z.infer<typeof stream>

/** A quarter turn either way swaps the frame's width and height as players show it. */
function turned(entry: Stream): boolean {
  const rotation = entry.side_data_list?.find((side) => side.rotation !== undefined)?.rotation
  const degrees = rotation ?? Number(entry.tags?.rotate ?? 0)
  return Math.abs(degrees) % 180 === 90
}

function videoOf(entry: Stream | undefined): MediaProbe['video'] {
  if (entry === undefined) {
    return null
  }
  const [width, height] = [entry.width ?? 0, entry.height ?? 0]
  const codec = entry.codec_name ?? 'unknown'
  return turned(entry) ? { codec, width: height, height: width } : { codec, width, height }
}

/** ffprobe's JSON report as a probe, or null when it is not one. */
export function parseProbe(json: string): MediaProbe | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  const parsed = report.safeParse(raw)
  if (!parsed.success) {
    return null
  }
  const { streams, format } = parsed.data
  const pictures = streams.filter((entry) => entry.codec_type === 'video')
  const moving = pictures.find((entry) => entry.disposition?.attached_pic !== 1)
  const duration = Number(format.duration ?? Number.NaN)
  return {
    containers: format.format_name.split(','),
    duration: Number.isFinite(duration) && duration >= 0 && duration < DURATION_MAX ? duration : null,
    video: videoOf(moving),
    audio: streams.find((entry) => entry.codec_type === 'audio')?.codec_name ?? null,
    cover: moving === undefined && pictures.length > 0,
  }
}

interface Playable {
  container: string
  video: readonly string[]
  audio: readonly string[]
}

const MP4: Playable = { container: 'mp4', video: ['h264'], audio: ['aac', 'mp3'] }
const OGG: Playable = { container: 'ogg', video: [], audio: ['opus', 'vorbis'] }
const PCM = ['pcm_u8', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le']

/** What browsers play, by extension: the container it must be and the codecs it may hold. */
const PLAYABLE: Readonly<Record<string, Playable>> = {
  mp4: MP4,
  m4v: MP4,
  m4a: { container: 'mp4', video: [], audio: ['aac'] },
  webm: { container: 'webm', video: ['vp8', 'vp9', 'av1'], audio: ['opus', 'vorbis'] },
  mp3: { container: 'mp3', video: [], audio: ['mp3'] },
  wav: { container: 'wav', video: [], audio: PCM },
  ogg: OGG,
  oga: OGG,
  opus: OGG,
  flac: { container: 'flac', video: [], audio: ['flac'] },
  aac: { container: 'aac', video: [], audio: ['aac'] },
}

/** Every extension the share page handles as audio or video. */
export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([...Object.keys(PLAYABLE), 'mov', 'mkv', 'ogv'])

/** Whether browsers play the file inline: a container and codecs they all decode. */
export function playsInBrowsers(extension: string, probe: MediaProbe): boolean {
  const rule = PLAYABLE[extension]
  if (rule === undefined || !probe.containers.includes(rule.container)) {
    return false
  }
  if (probe.video === null && probe.audio === null) {
    return false
  }
  const video = probe.video === null || rule.video.includes(probe.video.codec)
  return video && (probe.audio === null || rule.audio.includes(probe.audio))
}

const CODEC_NAMES: Readonly<Record<string, string>> = {
  h264: 'H.264',
  hevc: 'H.265',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
  prores: 'ProRes',
  theora: 'Theora',
  mpeg4: 'MPEG-4',
  aac: 'AAC',
  mp3: 'MP3',
  opus: 'Opus',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  alac: 'ALAC',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
}

const codecName = (codec: string) => CODEC_NAMES[codec] ?? (codec.startsWith('pcm_') ? 'PCM' : codec.toUpperCase())

/** The codecs a probe found, as people know them, such as "H.265, AAC". */
export function codecsOf(probe: MediaProbe): string {
  const codecs = [probe.video?.codec, probe.audio ?? undefined].filter((codec) => codec !== undefined)
  return codecs.length === 0 ? 'no streams' : codecs.map(codecName).join(', ')
}

/** "0:07", "3:25" or "1:02:09". */
export function durationLabel(seconds: number): string {
  const whole = seconds > 0 ? Math.max(1, Math.round(seconds)) : 0
  const [h, m, s] = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60]
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${String(h)}:${pad(m)}:${pad(s)}` : `${String(m)}:${pad(s)}`
}
