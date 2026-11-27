/** The query parameter the manifest's Needs you shortcut opens Seti with, as `?view=needs-you`. */
export const NEEDS_YOU_PARAM = 'view'

/** Whether an address is the manifest's Needs you shortcut. */
export const isNeedsYouShortcut = (url: URL): boolean => url.searchParams.get(NEEDS_YOU_PARAM) === 'needs-you'

/** What a launch into the running page does, so reopening Seti never reloads it needlessly. */
export type LaunchMove = { kind: 'hash'; hash: string } | { kind: 'needs-you' } | { kind: 'load'; url: string } | null

/** The move for a launch at `target` while the page shows `here`; null stays where the user was. */
export function launchMove(target: string, here: URL): LaunchMove {
  let url: URL
  try {
    url = new URL(target, here)
  } catch {
    return null
  }
  if (url.origin !== here.origin || url.pathname !== here.pathname) {
    return { kind: 'load', url: url.href }
  }
  if (isNeedsYouShortcut(url)) {
    return { kind: 'needs-you' }
  }
  if (url.search !== here.search) {
    return { kind: 'load', url: url.href }
  }
  return url.hash === '' || url.hash === here.hash ? null : { kind: 'hash', hash: url.hash }
}
