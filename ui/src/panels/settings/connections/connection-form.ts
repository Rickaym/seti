import {
  connectionInput,
  envFor,
  isMinted,
  neededSlots,
  VALUE_PLACEHOLDER,
  type ClientAuth,
  type Connection,
  type ConnectionInput,
  type ConnectionKind,
  type ConnectionRequest,
  type ConnectionSlot,
  type MintSettings,
} from '@seti/shared'

/** A connection as its forms edit it: every field as text, split into the API shape on save. */
export interface ConnectionForm {
  name: string
  env: string
  /** Whether the user typed the variable; until then it follows the name. */
  envEdited: boolean
  kind: ConnectionKind
  hosts: string
  addsHeader: boolean
  header: string
  template: string
  tokenUrl: string
  clientId: string
  clientAuth: ClientAuth
  scope: string
  audience: string
  resource: string
  issuer: string
  subject: string
  keyId: string
  thumbprint: string
  extra: string
}

const BEARER = `Bearer ${VALUE_PLACEHOLDER}`

const BLANK: ConnectionForm = {
  name: '',
  env: '',
  envEdited: false,
  kind: 'key',
  hosts: '',
  addsHeader: false,
  header: 'Authorization',
  template: BEARER,
  tokenUrl: '',
  clientId: '',
  clientAuth: 'client_secret_post',
  scope: '',
  audience: '',
  resource: '',
  issuer: '',
  subject: '',
  keyId: '',
  thumbprint: '',
  extra: '',
}

export interface ConnectionPreset {
  label: string
  hint: string
  form: Partial<ConnectionForm>
}

/** Starting points for a new connection; the user fills in the tenant, values and hosts. */
export const PRESETS: readonly ConnectionPreset[] = [
  { label: 'API key', hint: 'The agent sends it; Seti swaps in the key on its hosts.', form: { kind: 'key' } },
  {
    label: 'Header key',
    hint: 'Seti adds it as a header on its hosts; the agent never sends it.',
    form: { kind: 'key', addsHeader: true },
  },
  {
    label: 'OAuth client',
    hint: 'Seti mints a token with the client credentials grant and adds it.',
    form: { kind: 'client_credentials', addsHeader: true, clientAuth: 'client_secret_basic' },
  },
  {
    label: 'Entra ID app',
    hint: 'A Microsoft Entra app with a client secret, for Microsoft Graph.',
    form: {
      kind: 'client_credentials',
      addsHeader: true,
      hosts: 'graph.microsoft.com',
      tokenUrl: 'https://login.microsoftonline.com/TENANT_ID/oauth2/v2.0/token',
      scope: 'https://graph.microsoft.com/.default',
    },
  },
  {
    label: 'Refresh token',
    hint: 'Seti trades a refresh token for access tokens and keeps the newest one.',
    form: { kind: 'refresh_token', addsHeader: true, clientAuth: 'none' },
  },
  {
    label: 'Signed JWT',
    hint: 'RFC 7523: Seti signs a JWT with your private key and trades it for a token, as Salesforce does.',
    form: { kind: 'jwt_bearer', addsHeader: true },
  },
  {
    label: 'Google key file',
    hint: 'A Google service account key file; Seti signs its own token requests.',
    form: {
      kind: 'jwt_bearer',
      addsHeader: true,
      hosts: '*.googleapis.com',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
    },
  },
]

export const presetForm = (preset: ConnectionPreset): ConnectionForm => ({ ...BLANK, ...preset.form })

const KIND_LABEL: Record<ConnectionKind, string> = {
  key: 'Key',
  client_credentials: 'OAuth client',
  refresh_token: 'Refresh token',
  jwt_bearer: 'Signed JWT',
}

/** What a connection is, in a word or two; a signed JWT without an issuer is a Google key file. */
export const kindLabel = (connection: Pick<Connection, 'kind' | 'mint'>) =>
  connection.kind === 'jwt_bearer' && (connection.mint?.issuer ?? null) === null
    ? 'Google key file'
    : KIND_LABEL[connection.kind]

export const SLOT_LABEL: Record<ConnectionSlot, string> = {
  value: 'Key',
  client_id: 'Secret client ID',
  client_secret: 'Client secret',
  private_key: 'Private key',
  refresh_token: 'Refresh token',
  key_file: 'Key file',
}

/** Values pasted as several lines: PEM keys and JSON key files. */
export const MULTILINE: ReadonlySet<ConnectionSlot> = new Set(['private_key', 'key_file'])

/** Hosts typed one per line or separated by commas or spaces. */
const splitHosts = (hosts: string) =>
  hosts
    .split(/[\s,]+/)
    .map((host) => host.trim())
    .filter((host) => host !== '')

const orNull = (text: string) => (text.trim() === '' ? null : text.trim())

function extraParams(text: string): Record<string, string> {
  const pairs = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line): [string, string] => {
      const at = line.indexOf('=')
      return at < 0 ? [line, ''] : [line.slice(0, at).trim(), line.slice(at + 1).trim()]
    })
  return Object.fromEntries(pairs)
}

function mintOf(form: ConnectionForm): MintSettings | null {
  if (!isMinted(form.kind)) {
    return null
  }
  return {
    token_url: form.tokenUrl.trim(),
    client_id: orNull(form.clientId),
    client_auth: form.clientAuth,
    key_id: orNull(form.keyId),
    certificate_thumbprint: orNull(form.thumbprint),
    subject: orNull(form.subject),
    scope: orNull(form.scope),
    audience: orNull(form.audience),
    resource: orNull(form.resource),
    issuer: form.kind === 'jwt_bearer' ? orNull(form.issuer) : null,
    extra_params: extraParams(form.extra),
  }
}

/** The settings a form describes, as the API takes them. */
function settingsOf(form: ConnectionForm): ConnectionInput {
  return {
    name: form.name.trim(),
    kind: form.kind,
    env: (form.envEdited ? form.env : envFor(form.name.trim())).trim(),
    hosts: splitHosts(form.hosts),
    header: form.addsHeader ? { name: form.header.trim(), template: form.template.trim() } : null,
    mint: mintOf(form),
  }
}

/** The settings, or the first problem with them in words the form can show. */
export function checkedSettings(form: ConnectionForm): { settings: ConnectionRequest } | { error: string } {
  const parsed = connectionInput.safeParse(settingsOf(form))
  return parsed.success
    ? { settings: parsed.data }
    : { error: parsed.error.issues[0]?.message ?? 'Check the connection' }
}

/** The slots the form's connection needs before it works. */
export const neededFor = (form: ConnectionForm): ConnectionSlot[] => neededSlots(form.kind, mintOf(form))

const text = (value: string | null) => value ?? ''

function mintForm(mint: MintSettings): Partial<ConnectionForm> {
  return {
    tokenUrl: mint.token_url,
    clientId: text(mint.client_id),
    clientAuth: mint.client_auth,
    scope: text(mint.scope),
    audience: text(mint.audience),
    resource: text(mint.resource),
    issuer: text(mint.issuer),
    subject: text(mint.subject),
    keyId: text(mint.key_id),
    thumbprint: text(mint.certificate_thumbprint),
    extra: Object.entries(mint.extra_params)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  }
}

export function formOf(connection: Connection): ConnectionForm {
  const { mint, header } = connection
  return {
    ...BLANK,
    name: connection.name,
    env: connection.env,
    envEdited: true,
    kind: connection.kind,
    hosts: connection.hosts.join(', '),
    ...(header === null ? {} : { addsHeader: true, header: header.name, template: header.template }),
    ...(mint === null ? {} : mintForm(mint)),
  }
}

/** What a connection lacks or why it failed, in a few words; null when it is ready. */
export function statusText(connection: Connection): string | null {
  if (connection.missing.length > 0) {
    return `Needs ${connection.missing.map((slot) => SLOT_LABEL[slot].toLowerCase()).join(' and ')}`
  }
  return connection.mint_error === null ? null : `Mint failed: ${connection.mint_error}`
}
