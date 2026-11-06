import type { WebhookChannelInfo } from '@seti/shared'

/** The URL a sender posts to: the public one when Seti has a public hostname. */
export const hookUrl = (info: WebhookChannelInfo) => info.public_url ?? `${window.location.origin}${info.path}`
