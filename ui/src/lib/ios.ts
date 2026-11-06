/** iPhone, iPod or iPad; iPadOS asks for desktop sites as a Mac, which has no touch screen. */
export const isIosAgent = (ua: string, maxTouchPoints: number) =>
  /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && maxTouchPoints > 1)

const isIos = () => isIosAgent(navigator.userAgent, navigator.maxTouchPoints)

/** Opened from the Home Screen or as an installed app, not in a browser tab. */
const installed = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  ('standalone' in navigator && navigator.standalone === true)

/** Safari on iOS gives push and the app badge only to the Home Screen app. */
export const needsHomeScreen = () => isIos() && !installed()
