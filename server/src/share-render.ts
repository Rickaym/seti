import { previewBody } from './html-preview.js'
import type { ShareRequest } from './share-path.js'

/**
 * Hosts a live page may load scripts, styles and fonts from. Each sees the visitor's address and
 * nothing else of Seti's: what it serves runs in the same opaque, networkless frame as the page.
 */
export const SHARE_PAGE_CDNS: readonly { source: string; reason: string }[] = [
  {
    source: 'https://cdnjs.cloudflare.com/ajax/libs/',
    reason: 'Curated open-source libraries; nobody can publish arbitrary files there',
  },
  {
    source: 'https://cdn.jsdelivr.net/npm/',
    reason: 'npm packages, where generated pages most often load Chart.js, D3, Plotly or Mermaid',
  },
  { source: 'https://unpkg.com/', reason: 'npm packages through the other mirror generated pages name' },
]

/** Set by the share handler on a rendered share's shell and frame; the headers step drops it. */
export const RENDER_MARK = 'X-Seti-Share-Render'

const CDN_SOURCES = SHARE_PAGE_CDNS.map((cdn) => cdn.source).join(' ')

/**
 * The live page: an opaque origin with scripts, no storage, no network but the CDNs' scripts,
 * styles and fonts, and no frames, workers, forms or plugins. Only a Seti page may frame it.
 */
export const SHARE_FRAME_POLICY = [
  'sandbox allow-scripts',
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob: ${CDN_SOURCES}`,
  `style-src 'unsafe-inline' data: blob: ${CDN_SOURCES}`,
  'img-src data: blob:',
  `font-src data: blob: ${CDN_SOURCES}`,
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ')

/** The shell runs nothing and frames only its own live page, which may not navigate elsewhere. */
function shellPolicy(own: string | null): string {
  const frame = own === null ? "'none'" : `${own}/frame`
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `frame-src ${frame}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

/** Every powerful feature off, for the shell and so for the frame it holds. */
export const RENDER_PERMISSIONS = [
  'accelerometer',
  'autoplay',
  'bluetooth',
  'camera',
  'clipboard-read',
  'clipboard-write',
  'display-capture',
  'encrypted-media',
  'fullscreen',
  'gamepad',
  'geolocation',
  'gyroscope',
  'hid',
  'idle-detection',
  'local-fonts',
  'magnetometer',
  'microphone',
  'midi',
  'payment',
  'picture-in-picture',
  'publickey-credentials-create',
  'publickey-credentials-get',
  'screen-wake-lock',
  'serial',
  'storage-access',
  'usb',
  'web-share',
  'window-management',
  'xr-spatial-tracking',
]
  .map((feature) => `${feature}=()`)
  .join(', ')

/** Headers of a rendered share's shell and of its frame, in place of the code view's policy. */
export function applyRenderHeaders(headers: Headers, request: ShareRequest, origin: string | null): void {
  const own = origin === null ? null : `${origin}/share/${request.token}`
  headers.set('Content-Security-Policy', request.part === 'frame' ? SHARE_FRAME_POLICY : shellPolicy(own))
  headers.set('Permissions-Policy', RENDER_PERMISSIONS)
  headers.set('X-DNS-Prefetch-Control', 'off')
  if (request.part === 'frame') {
    headers.set('X-Frame-Options', 'SAMEORIGIN')
  }
}

/** Only a frame gets the live page; opened as a tab it could navigate itself to the web. */
export const isFrameLoad = (fetchDest: string | undefined): boolean => fetchDest === 'iframe'

/** The stored HTML with in-memory storage, since the frame's opaque origin refuses the real one. */
export const frameDocument = (content: Buffer): Buffer => previewBody(content, true)
