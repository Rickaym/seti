import { sign } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

// A small Google Play Developer API client: one edit, its bundle, track and listing, then commit.

const SCOPE = 'https://www.googleapis.com/auth/androidpublisher'
const TOKEN_URI = 'https://oauth2.googleapis.com/token'
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications'
const UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications'
const NOTES_MAX = 500

/** Play's limits for the listing text files, in characters. */
const LISTING_TEXT = {
  'title.txt': { field: 'title', max: 30 },
  'short-description.txt': { field: 'shortDescription', max: 80 },
  'full-description.txt': { field: 'fullDescription', max: 4000 },
}

/** Listing graphics: the folder under `graphics/` and the Play image type it uploads as. */
const GRAPHICS = {
  icon: 'icon',
  'feature-graphic': 'featureGraphic',
  'phone-screenshots': 'phoneScreenshots',
}

const IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
])

/**
 * @typedef {object} Listing
 * @property {string} language
 * @property {Record<string, string>} text
 * @property {{ type: string, files: string[] }[]} images
 */

/**
 * @typedef {object} Release
 * @property {number} versionCode
 * @property {string} name
 * @property {string} notes
 */

/**
 * @typedef {object} PublishOptions
 * @property {string} keyFile
 * @property {string} packageName
 * @property {{ track: string, bundle: string, release: Release }} [build]
 * @property {Listing[]} [listings]
 * @property {(line: string) => void} log
 */

/**
 * @typedef {object} PublishResult
 * @property {boolean} draft
 * @property {boolean} sentForReview
 */

class PlayError extends Error {}

/**
 * @param {string} text
 * @returns {unknown}
 */
function parseJson(text) {
  return JSON.parse(text)
}

/**
 * @param {Response} res
 * @returns {Promise<string>}
 */
async function errorText(res) {
  const text = await res.text()
  try {
    const body = /** @type {{ error?: { message?: string } | string, error_description?: string }} */ (parseJson(text))
    if (typeof body.error === 'object') {
      return body.error.message ?? text
    }
    return body.error_description ?? body.error ?? text
  } catch {
    return text.slice(0, 500)
  }
}

/**
 * Exchanges the service account key for an access token; the key never leaves this function.
 * @param {string} keyFile
 * @returns {Promise<string>}
 */
async function accessToken(keyFile) {
  const key = /** @type {{ client_email?: string, private_key?: string, token_uri?: string }} */ (
    parseJson(readFileSync(keyFile, 'utf8'))
  )
  if (key.client_email === undefined || key.private_key === undefined) {
    throw new PlayError(`${keyFile} is not a service account key: it needs client_email and private_key.`)
  }
  const audience = key.token_uri ?? TOKEN_URI
  const now = Math.floor(Date.now() / 1000)
  /** @param {object} value */
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const claims = { iss: key.client_email, scope: SCOPE, aud: audience, iat: now, exp: now + 3600 }
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}`
  const signature = sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url')
  const res = await fetch(audience, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  })
  if (!res.ok) {
    throw new PlayError(`Google refused the service account: ${await errorText(res)}`)
  }
  const body = /** @type {{ access_token?: string }} */ (await res.json())
  return body.access_token ?? ''
}

/**
 * @param {string} root
 * @returns {Record<string, string>}
 */
function listingText(root) {
  /** @type {Record<string, string>} */
  const text = {}
  for (const [file, { field, max }] of Object.entries(LISTING_TEXT)) {
    const path = join(root, file)
    if (!existsSync(path)) {
      throw new PlayError(`Missing ${path}.`)
    }
    const value = readFileSync(path, 'utf8').trim()
    if (value.length === 0 || value.length > max) {
      throw new PlayError(`${path} has ${String(value.length)} characters; Play takes 1 to ${String(max)}.`)
    }
    text[field] = value
  }
  return text
}

/**
 * Reads `<dir>/<language>/` in the layout of android/play/listings and checks Play's limits.
 * @param {string} dir
 * @returns {Listing[]}
 */
export function readListings(dir) {
  return readdirSync(dir).map((language) => {
    const root = join(dir, language)
    const images = Object.entries(GRAPHICS).flatMap(([folder, type]) => {
      const path = join(root, 'graphics', folder)
      if (!existsSync(path)) {
        return []
      }
      const files = readdirSync(path)
        .filter((name) => IMAGE_TYPES.has(extname(name).toLowerCase()))
        .sort((a, b) => a.localeCompare(b))
        .map((name) => join(path, name))
      return files.length > 0 ? [{ type, files }] : []
    })
    return { language, text: listingText(root), images }
  })
}

/** @param {string} text */
function trimNotes(text) {
  return text.length <= NOTES_MAX ? text : `${text.slice(0, NOTES_MAX - 3).trimEnd()}...`
}

/**
 * @param {string} token
 * @param {string} method
 * @param {string} url
 * @param {{ json?: unknown, file?: string }} [body]
 * @returns {Promise<unknown>}
 */
async function request(token, method, url, body = {}) {
  /** @type {Record<string, string>} */
  const headers = { authorization: `Bearer ${token}` }
  /** @type {string | Buffer | undefined} */
  let payload
  if (body.json !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body.json)
  } else if (body.file !== undefined) {
    headers['content-type'] = IMAGE_TYPES.get(extname(body.file).toLowerCase()) ?? 'application/octet-stream'
    payload = readFileSync(body.file)
  }
  const res = await fetch(url, { method, headers, body: payload ?? null })
  if (!res.ok) {
    throw new PlayError(`${method} ${url.split('?')[0] ?? url}: ${await errorText(res)}`)
  }
  const text = await res.text()
  return text === '' ? {} : parseJson(text)
}

/** One open edit of one app. */
class Edit {
  /**
   * @param {string} token
   * @param {string} packageName
   * @param {string} id
   */
  constructor(token, packageName, id) {
    const path = `${encodeURIComponent(packageName)}/edits/${encodeURIComponent(id)}`
    this.token = token
    this.url = `${API}/${path}`
    this.upload = `${UPLOAD}/${path}`
  }

  /**
   * @param {string} token
   * @param {string} packageName
   * @returns {Promise<Edit>}
   */
  static async open(token, packageName) {
    const created = /** @type {{ id: string }} */ (
      await request(token, 'POST', `${API}/${encodeURIComponent(packageName)}/edits`, { json: {} })
    )
    return new Edit(token, packageName, created.id)
  }

  /**
   * @param {string} method
   * @param {string} url
   * @param {{ json?: unknown, file?: string }} [body]
   */
  async call(method, url, body) {
    return request(this.token, method, url, body)
  }

  /**
   * @param {string} bundle
   * @param {number} versionCode
   */
  async uploadBundle(bundle, versionCode) {
    const uploaded = /** @type {{ versionCode?: number }} */ (
      await this.call('POST', `${this.upload}/bundles?uploadType=media`, { file: bundle })
    )
    if (uploaded.versionCode !== versionCode) {
      throw new PlayError(`Play read versionCode ${String(uploaded.versionCode)}, expected ${String(versionCode)}.`)
    }
  }

  /**
   * Puts the release on the track; an app Play has not reviewed yet only takes drafts.
   * @param {string} track
   * @param {Release} release
   * @returns {Promise<boolean>} True when the release went in as a draft.
   */
  async setTrack(track, release) {
    /** @param {string} status */
    const put = async (status) =>
      this.call('PUT', `${this.url}/tracks/${track}`, {
        json: {
          track,
          releases: [
            {
              name: release.name,
              versionCodes: [String(release.versionCode)],
              status,
              releaseNotes: [{ language: 'en-US', text: trimNotes(release.notes) }],
            },
          ],
        },
      })
    try {
      await put('completed')
      return false
    } catch (error) {
      if (!(error instanceof PlayError && /draft/i.test(error.message))) {
        throw error
      }
      await put('draft')
      return true
    }
  }

  /** @param {Listing} listing */
  async setListing(listing) {
    const base = `${this.url}/listings/${listing.language}`
    await this.call('PUT', base, { json: { language: listing.language, ...listing.text } })
    for (const { type, files } of listing.images) {
      await this.call('DELETE', `${base}/${type}`)
      for (const file of files) {
        await this.call('POST', `${this.upload}/listings/${listing.language}/${type}?uploadType=media`, { file })
      }
    }
  }

  /** @returns {Promise<boolean>} False when managed publishing holds the changes for review. */
  async commit() {
    try {
      await this.call('POST', `${this.url}:commit`)
      return true
    } catch (error) {
      if (!(error instanceof PlayError && error.message.includes('changesNotSentForReview'))) {
        throw error
      }
      await this.call('POST', `${this.url}:commit?changesNotSentForReview=true`)
      return false
    }
  }

  async discard() {
    await this.call('DELETE', this.url).catch(() => undefined)
  }
}

/**
 * Opens one edit for the app, applies the build and the listings, and commits it.
 * @param {PublishOptions} options
 * @returns {Promise<PublishResult>}
 */
export async function publish({ keyFile, packageName, build, listings = [], log }) {
  const edit = await Edit.open(await accessToken(keyFile), packageName)
  try {
    let draft = false
    if (build !== undefined) {
      log(`Uploading ${build.bundle}`)
      await edit.uploadBundle(build.bundle, build.release.versionCode)
      draft = await edit.setTrack(build.track, build.release)
    }
    for (const listing of listings) {
      log(`Updating the ${listing.language} listing`)
      await edit.setListing(listing)
    }
    return { draft, sentForReview: await edit.commit() }
  } catch (error) {
    await edit.discard()
    throw error
  }
}
