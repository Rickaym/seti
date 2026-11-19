import { senderDefinition, WEBHOOK_SENDERS } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { EMPTY_SENDER, formOfSender, senderOfForm } from './sender-form'

describe('the custom sender form', () => {
  it('describes every catalog sender and reads it back unchanged', () => {
    for (const sender of WEBHOOK_SENDERS) {
      const again = senderDefinition.parse(senderOfForm(formOfSender(sender.definition)))
      expect(again, sender.id).toEqual(sender.definition)
    }
  })

  it('makes a token sender, comma lists of paths and the defaults of empty numbers', () => {
    const form = {
      ...EMPTY_SENDER,
      signs: false,
      header: ' X-Token ',
      prefix: 'Bearer ',
      appSecret: false,
      eventIn: 'body' as const,
      event: 'type',
      title: 'data.title, name ,',
      maxAge: '',
      detailMax: 'abc',
    }
    expect(senderDefinition.parse(senderOfForm(form))).toMatchObject({
      signature: { scheme: 'token', header: 'X-Token', prefix: 'Bearer ' },
      secret: 'generated',
      event: { in: 'body', name: 'type' },
      title: ['data.title', 'name'],
      max_age_s: 300,
      detail_max: 1000,
      handshake: null,
    })
    expect(senderDefinition.safeParse(senderOfForm(EMPTY_SENDER)).success).toBe(false)
  })
})
