import {
  SENDER_DETAIL_MAX,
  SENDER_MAX_AGE_S,
  type SenderDefinition,
  type SenderDefinitionInput,
  type SenderSigned,
} from '@seti/shared'

type Where = 'none' | 'header' | 'body'

/** A custom sender as the form holds it: every field a string or a switch. */
export interface SenderForm {
  signs: boolean
  header: string
  algorithm: 'sha256' | 'sha1' | 'sha512'
  base64: boolean
  prefix: string
  separator: 'none' | 'comma' | 'space'
  signed: SenderSigned
  base64Key: boolean
  timestampIn: Where | 'signature'
  timestamp: string
  maxAge: string
  idIn: Where
  id: string
  appSecret: boolean
  eventIn: Where
  event: string
  action: string
  title: string
  link: string
  detail: string
  detailMax: string
  checkPath: string
  checkEquals: string
  checkEcho: string
}

export const EMPTY_SENDER: SenderForm = {
  signs: true,
  header: '',
  algorithm: 'sha256',
  base64: false,
  prefix: '',
  separator: 'none',
  signed: '{body}',
  base64Key: false,
  timestampIn: 'none',
  timestamp: '',
  maxAge: String(SENDER_MAX_AGE_S.default),
  idIn: 'none',
  id: '',
  appSecret: true,
  eventIn: 'none',
  event: '',
  action: '',
  title: '',
  link: '',
  detail: '',
  detailMax: String(SENDER_DETAIL_MAX.default),
  checkPath: '',
  checkEquals: '',
  checkEcho: '',
}

const list = (text: string) =>
  text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')

const source = <W extends string>(where: W | 'none', name: string): { in: W; name: string } | null =>
  where === 'none' || name.trim() === '' ? null : { in: where, name: name.trim() }

const numberOr = (text: string, fallback: number) => {
  const value = Number(text)
  return text.trim() === '' || !Number.isFinite(value) ? fallback : Math.round(value)
}

/** The definition a filled-in form describes; the server checks it. */
export function senderOfForm(form: SenderForm): SenderDefinitionInput {
  const header = form.header.trim()
  const check = [form.checkPath, form.checkEquals, form.checkEcho].map((text) => text.trim())
  return {
    signature: form.signs
      ? {
          scheme: 'hmac',
          header,
          algorithm: form.algorithm,
          encoding: form.base64 ? 'base64' : 'hex',
          prefix: form.prefix,
          separator: form.separator,
          signed: form.signed,
          key: form.base64Key ? 'base64' : 'text',
        }
      : { scheme: 'token', header, prefix: form.prefix },
    timestamp: form.signs ? source(form.timestampIn, form.timestamp) : null,
    id: source(form.idIn, form.id),
    max_age_s: numberOr(form.maxAge, SENDER_MAX_AGE_S.default),
    secret: form.appSecret ? 'sender' : 'generated',
    event: source(form.eventIn, form.event),
    action: form.action.trim() === '' ? null : form.action.trim(),
    title: list(form.title),
    link: list(form.link),
    detail: list(form.detail),
    detail_max: numberOr(form.detailMax, SENDER_DETAIL_MAX.default),
    handshake: check.every((text) => text !== '')
      ? { path: check[0] ?? '', equals: check[1] ?? '', echo: check[2] ?? '' }
      : null,
  }
}

type Parts<K extends keyof SenderForm> = Pick<SenderForm, K>

function signatureForm({ signature }: SenderDefinition): Parts<'signs' | 'header' | 'prefix'> & Partial<SenderForm> {
  const common = { header: signature.header, prefix: signature.prefix }
  if (signature.scheme === 'token') {
    return { ...common, signs: false }
  }
  return {
    ...common,
    signs: true,
    algorithm: signature.algorithm,
    base64: signature.encoding === 'base64',
    separator: signature.separator,
    signed: signature.signed,
    base64Key: signature.key === 'base64',
  }
}

function replayForm({ timestamp, id, max_age_s: maxAge }: SenderDefinition): Partial<SenderForm> {
  return {
    ...(timestamp === null ? {} : { timestampIn: timestamp.in, timestamp: timestamp.name }),
    ...(id === null ? {} : { idIn: id.in, id: id.name }),
    maxAge: String(maxAge),
  }
}

function checkForm({ handshake }: SenderDefinition): Partial<SenderForm> {
  return handshake === null
    ? {}
    : { checkPath: handshake.path, checkEquals: handshake.equals, checkEcho: handshake.echo }
}

/** The form of a stored definition, for editing it. */
export function formOfSender(definition: SenderDefinition): SenderForm {
  const { event } = definition
  return {
    ...EMPTY_SENDER,
    ...signatureForm(definition),
    ...replayForm(definition),
    ...checkForm(definition),
    ...(event === null ? {} : { eventIn: event.in, event: event.name }),
    appSecret: definition.secret === 'sender',
    action: definition.action ?? '',
    title: definition.title.join(', '),
    link: definition.link.join(', '),
    detail: definition.detail.join(', '),
    detailMax: String(definition.detail_max),
  }
}
