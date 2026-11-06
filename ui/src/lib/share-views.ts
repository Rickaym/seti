import type { ShareView } from '@seti/shared'

/** The apps whose bots fetched a link, latest first and each once, such as "Slack, WhatsApp". */
export function unfurlerNames(views: readonly ShareView[]): string {
  return [...new Set(views.map((view) => view.unfurler).filter((name) => name !== null))].join(', ')
}
