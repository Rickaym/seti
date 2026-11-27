/** The tag of the notification a live EA call shows on Android; the Android app looks for it. */
export const EA_CALL_NOTICE_TAG = 'seti-ea-call'

/** The buttons on that notification, as the service worker reports them to the page. */
export const EA_CALL_ACTIONS = ['ea-mute', 'ea-hang-up'] as const
export type EaCallAction = (typeof EA_CALL_ACTIONS)[number]

/** The message the service worker posts to the page when a call button is pressed. */
export interface EaCallActionMessage {
  type: 'seti:ea-call'
  action: EaCallAction
}

/** The page message for a press on the call notification, or null for any other press. */
export function eaCallActionMessage(tag: string, action: string): EaCallActionMessage | null {
  const known = EA_CALL_ACTIONS.find((name) => name === action)
  return tag === EA_CALL_NOTICE_TAG && known !== undefined ? { type: 'seti:ea-call', action: known } : null
}
