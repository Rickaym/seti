import type { Aside } from '@seti/mod-api'

/** Who asked an aside, for its label; null for the user's own. */
export function askerLabel(aside: Pick<Aside, 'asked_by' | 'asker_title'>): string | null {
  if (aside.asked_by === 'agent') {
    return `Asked by ${aside.asker_title ?? 'an agent'}`
  }
  return aside.asked_by === 'ea' ? 'Asked by the EA' : null
}

/** The clock time an aside was asked, as this device writes it. */
export const askedTime = (at: string) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
