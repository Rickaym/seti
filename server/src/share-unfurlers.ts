/** Link preview bots by user agent, with the app each fetches for; in-app browsers differ. */
const UNFURLERS: readonly (readonly [RegExp, string])[] = [
  [/Slackbot|Slack-ImgProxy/i, 'Slack'],
  [/WhatsApp/i, 'WhatsApp'],
  [/facebookexternalhit|Facebot|meta-externalagent/i, 'Facebook'],
  [/TelegramBot/i, 'Telegram'],
  [/Twitterbot/i, 'X'],
  [/Discordbot/i, 'Discord'],
  [/LinkedInBot/i, 'LinkedIn'],
  [/SkypeUriPreview|MicrosoftPreview/i, 'Microsoft Teams'],
  [/Applebot/i, 'Apple'],
  [/Google-PageRenderer|GoogleImageProxy/i, 'Google'],
  [/redditbot/i, 'Reddit'],
  [/Mastodon/i, 'Mastodon'],
  [/Bluesky|Cardyb/i, 'Bluesky'],
  [/Pinterestbot/i, 'Pinterest'],
  [/Embedly|Iframely|vkShare|Zoombot|Mattermost|RocketChat|Synapse|matrix/i, 'Link preview'],
]

/** The app whose bot fetched a share for a link preview, or null for a person's browser. */
export function unfurlerOf(userAgent: string): string | null {
  return UNFURLERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null
}
