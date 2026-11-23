/** A file the agent should open, not a message: 25 MB each, 50 MB and 20 files a message. */
export const ATTACHMENT_FILE_MAX = 25 * 1024 * 1024
export const ATTACHMENT_MESSAGE_MAX = 50 * 1024 * 1024
export const ATTACHMENTS_PER_MESSAGE = 20

/** No bytes for this long and the composer calls an upload stalled. */
export const UPLOAD_STALL_MS = 30 * 1000
/** No bytes for this long and the server gives the upload up and removes what arrived. */
export const UPLOAD_IDLE_MS = 60 * 1000
/** How long one upload may take in all: a full file at about 14 KB a second. */
export const UPLOAD_REQUEST_MS = 30 * 60 * 1000

/** Where the share sheet posts shared files and text; the service worker takes the post. */
export const SHARE_TARGET_PATH = '/share-target'

/** The page a share lands on, which the share target redirects to. */
export const SHARE_HASH = '#share'
