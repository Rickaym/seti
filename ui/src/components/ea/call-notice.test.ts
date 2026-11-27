import { EA_CALL_NOTICE_TAG, eaCallActionMessage } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { callNotice } from './call-notice'

describe('callNotice', () => {
  it('shows the microphone state with Mute and Hang up, under the tag the Android app holds', () => {
    const live = callNotice(true)
    expect(live).toMatchObject({ tag: EA_CALL_NOTICE_TAG, body: 'Microphone on', requireInteraction: true })
    expect(live.actions.map((button) => button.title)).toEqual(['Mute', 'Hang up'])
    expect(callNotice(false)).toMatchObject({ body: 'Muted' })
    expect(callNotice(false).actions[0]?.title).toBe('Unmute')
  })
})

describe('eaCallActionMessage', () => {
  it('reports a button on the call notification, and nothing for any other press', () => {
    expect(eaCallActionMessage(EA_CALL_NOTICE_TAG, 'ea-hang-up')).toEqual({
      type: 'seti:ea-call',
      action: 'ea-hang-up',
    })
    expect(eaCallActionMessage(EA_CALL_NOTICE_TAG, '')).toBeNull()
    expect(eaCallActionMessage('agent-7', 'ea-mute')).toBeNull()
  })
})
