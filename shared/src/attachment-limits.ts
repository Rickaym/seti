/** A file the agent should open, not a message: 25 MB each, 50 MB and 20 files a message. */
export const ATTACHMENT_FILE_MAX = 25 * 1024 * 1024
export const ATTACHMENT_MESSAGE_MAX = 50 * 1024 * 1024
export const ATTACHMENTS_PER_MESSAGE = 20

/** Where the share sheet posts shared files and text; the service worker takes the post. */
export const SHARE_TARGET_PATH = '/share-target'

/** The page a share lands on, which the share target redirects to. */
export const SHARE_HASH = '#share'
