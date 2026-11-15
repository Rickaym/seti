import { ATTACHMENT_FILE_MAX, ATTACHMENTS_PER_MESSAGE, SHARE_TARGET_PATH } from '@seti/shared/attachment-limits'
import { describe, expect, it } from 'vitest'
import { clearShare, dropSharedFile, fitLimits, readShare, receiveShare, SHARE_CACHE } from './share-inbox'

const ORIGIN = 'https://seti.example'

/** The part of the Cache API the inbox uses, kept in memory and keyed by path. */
function fakeCaches(): CacheStorage {
  const stores = new Map<string, Map<string, Response>>()
  const keyOf = (request: RequestInfo | URL) => new URL(request instanceof Request ? request.url : request, ORIGIN).href
  const cache = (entries: Map<string, Response>) =>
    ({
      put: async (request: RequestInfo | URL, response: Response) => {
        entries.set(keyOf(request), response)
        return Promise.resolve()
      },
      match: async (request: RequestInfo | URL) => Promise.resolve(entries.get(keyOf(request))?.clone()),
      delete: async (request: RequestInfo | URL) => Promise.resolve(entries.delete(keyOf(request))),
    }) as unknown as Cache
  return {
    has: async (name: string) => Promise.resolve(stores.has(name)),
    delete: async (name: string) => Promise.resolve(stores.delete(name)),
    open: async (name: string) => {
      const entries = stores.get(name) ?? new Map<string, Response>()
      stores.set(name, entries)
      return Promise.resolve(cache(entries))
    },
  } as unknown as CacheStorage
}

function sharePost(fields: Record<string, string>, files: File[]): Request {
  const form = new FormData()
  for (const [name, value] of Object.entries(fields)) {
    form.append(name, value)
  }
  for (const file of files) {
    form.append('files', file)
  }
  return new Request(`${ORIGIN}${SHARE_TARGET_PATH}`, { method: 'POST', body: form })
}

describe('fitLimits', () => {
  it('keeps files in order until a limit, and says why each other file stays behind', () => {
    const big = { name: 'video.mp4', size: ATTACHMENT_FILE_MAX + 1 }
    const files = [{ name: 'a.txt', size: 10 }, big, { name: 'b.txt', size: 20 }]
    expect(fitLimits(files)).toEqual({
      kept: [0, 2],
      left: [{ name: 'video.mp4', size: big.size, reason: 'larger than 25 MB' }],
    })
  })

  it('stops at the per-message count and the per-message total', () => {
    const many = Array.from({ length: ATTACHMENTS_PER_MESSAGE + 1 }, (_, n) => ({ name: `${String(n)}.txt`, size: 1 }))
    expect(fitLimits(many).left).toEqual([{ name: '20.txt', size: 1, reason: 'more than 20 files' }])
    const heavy = [0, 1, 2].map((n) => ({ name: `${String(n)}.bin`, size: ATTACHMENT_FILE_MAX }))
    expect(fitLimits(heavy).left.map((file) => file.reason)).toEqual(['over 50 MB in all'])
  })
})

describe('the share inbox', () => {
  it('keeps the posted files and text, then redirects to the Share page', async () => {
    const storage = fakeCaches()
    const photo = new File(['png bytes'], 'photo.png', { type: 'image/png' })
    const response = await receiveShare(
      sharePost({ title: ' Release notes ', text: 'Read this', url: 'https://example.com/notes' }, [photo]),
      storage,
      'share-1',
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(`${ORIGIN}/#share`)

    const share = await readShare(storage)
    expect(share?.manifest).toMatchObject({
      id: 'share-1',
      title: 'Release notes',
      text: 'Read this',
      url: 'https://example.com/notes',
      left: [],
    })
    expect(share?.files.map(({ file }) => [file.name, file.type, file.size])).toEqual([['photo.png', 'image/png', 9]])
    expect(await share?.files[0]?.file.text()).toBe('png bytes')
  })

  it('ignores the empty file a text-only share carries, and a new share replaces the last', async () => {
    const storage = fakeCaches()
    await receiveShare(sharePost({}, [new File(['old'], 'old.txt')]), storage, 'first')
    await receiveShare(sharePost({ text: 'just a link' }, [new File([], '')]), storage, 'second')
    const share = await readShare(storage)
    expect(share?.manifest.id).toBe('second')
    expect(share?.files).toEqual([])
  })

  it('drops one file for good, and clearing forgets the share', async () => {
    const storage = fakeCaches()
    const files = [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]
    await receiveShare(sharePost({}, files), storage, 'share')
    await dropSharedFile(storage, 0)
    expect((await readShare(storage))?.files.map(({ file }) => file.name)).toEqual(['b.txt'])
    await clearShare(storage)
    expect(await storage.has(SHARE_CACHE)).toBe(false)
    expect(await readShare(storage)).toBeNull()
  })

  it('still lands on the Share page when the post is not a form', async () => {
    const storage = fakeCaches()
    const post = new Request(`${ORIGIN}${SHARE_TARGET_PATH}`, { method: 'POST', body: 'not a form' })
    const response = await receiveShare(post, storage, 'broken')
    expect(response.status).toBe(303)
    expect(await readShare(storage)).toBeNull()
  })
})
