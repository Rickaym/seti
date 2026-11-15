import { clearShare, dropSharedFile, readShare, type Share } from '../../sw/share-inbox'

export type { LeftFile, Share, SharedFile, ShareManifest } from '../../sw/share-inbox'

/** The Cache API lives only in secure contexts, the only ones where the share sheet offers Seti. */
const storage = (): CacheStorage | null => ('caches' in window ? window.caches : null)

/** The share the service worker kept on this device until the Share page sends or cancels it. */
export const shareInbox = {
  read: async (): Promise<Share | null> => {
    const caches = storage()
    return caches === null ? null : readShare(caches)
  },
  drop: async (index: number): Promise<void> => {
    const caches = storage()
    await (caches === null ? undefined : dropSharedFile(caches, index))
  },
  clear: async (): Promise<void> => {
    const caches = storage()
    await (caches === null ? undefined : clearShare(caches))
  },
}
