import {
  CONNECTION_TEMPLATES,
  connectionCreateInput,
  connectionTemplate,
  expandTemplate,
  providerOf,
  reachesProvider,
  templateMatches,
  templateValues,
  type Connection,
  type ConnectionTemplate,
  type TemplateFieldFormat,
} from '@seti/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { auditEvents } from './store/audit.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'
import { clearConnections } from './test-connections.js'

const app = createApp()
const LOCAL = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006' }
const TENANT = '0000aaaa-11bb-22cc-33dd-444444eeeeee'
const APP = '1111bbbb-22cc-33dd-44ee-555555ffffff'
const SECRET = ['entra', 'template', 'secret', 'Qz71'].join('-')
const NONE = { names: new Set<string>(), envs: new Set<string>() }

const SAMPLE: Record<TemplateFieldFormat, string> = {
  text: 'sample',
  guid: TENANT,
  email: 'someone@example.com',
  subdomain: 'your-domain',
}

const sampleFields = (template: ConnectionTemplate) =>
  Object.fromEntries(
    template.fields.filter((field) => field.slot === null).map((field) => [field.key, SAMPLE[field.format]]),
  )

const sampleSecrets = (template: ConnectionTemplate) =>
  Object.fromEntries(template.fields.filter((field) => field.slot !== null).map((field) => [field.key, 'fake-value']))

function templateOf(id: string): ConnectionTemplate {
  const found = connectionTemplate(id)
  if (found === undefined) {
    throw new Error(`No template ${id}`)
  }
  return found
}

interface Extra {
  taken?: typeof NONE
  write?: string[]
}

function expanded(id: string, parts: string[], fields: Record<string, string> = {}, extra: Extra = {}) {
  const made = expandTemplate(templateOf(id), { parts, write: extra.write ?? [], fields }, extra.taken ?? NONE)
  if ('error' in made) {
    throw new Error(made.error)
  }
  return made.connections
}

const ENTRA_FIELDS = { tenant: TENANT, client_id: APP }

async function post(body: unknown, auth: Record<string, string> = USER_AUTH) {
  const res = await app.request('/api/connections/from-template', {
    method: 'POST',
    headers: { ...LOCAL, ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, text: await res.text() }
}

async function listed(): Promise<Connection[]> {
  const res = await app.request('/api/connections', { headers: { ...LOCAL, ...USER_AUTH } })
  return ((await res.json()) as { data: Connection[] }).data
}

afterEach(clearConnections)

describe('the connection template catalog', () => {
  it('has unique ids and an https docs page for every template', () => {
    const ids = CONNECTION_TEMPLATES.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of CONNECTION_TEMPLATES) {
      expect(entry.docs, entry.id).toMatch(/^https:\/\//)
      expect(entry.title.length, entry.id).toBeGreaterThan(0)
    }
  })

  it.each(CONNECTION_TEMPLATES.map((entry) => [entry.id, entry] as const))(
    '%s expands to connections the create API accepts, whole and one API at a time',
    (_id, entry) => {
      const all = entry.parts.map((part) => part.id)
      const choices = entry.parts.length === 0 ? [[]] : [all, ...all.map((part) => [part])]
      const values = templateValues(entry, sampleSecrets(entry))
      expect(values).not.toHaveProperty('error')
      for (const parts of choices) {
        const made = expandTemplate(entry, { parts, write: parts.slice(0, 1), fields: sampleFields(entry) }, NONE)
        if ('error' in made) {
          throw new Error(`${entry.id}: ${made.error}`)
        }
        expect(made.connections).toHaveLength(entry.parts_mode === 'each' ? Math.max(parts.length, 1) : 1)
        for (const connection of made.connections) {
          expect(connection.hosts.length, entry.id).toBeGreaterThan(0)
          expect(JSON.stringify(connection), entry.id).not.toMatch(/\{[a-z_]+\}(?!\})/)
          const parsed = connectionCreateInput.safeParse({ ...connection, values })
          expect(parsed.success, `${entry.id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true)
        }
      }
    },
  )

  it('puts the tenant in the token URL and makes one connection per Microsoft API', () => {
    const [graph, arm] = expanded('microsoft_entra', ['graph', 'arm'], ENTRA_FIELDS)
    expect(graph).toMatchObject({
      name: 'entra_graph',
      env: 'ENTRA_GRAPH',
      kind: 'client_credentials',
      hosts: ['graph.microsoft.com'],
      header: { name: 'Authorization', template: 'Bearer {{value}}' },
      mint: {
        token_url: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
        client_id: APP,
        client_auth: 'client_secret_post',
        scope: 'https://graph.microsoft.com/.default',
      },
    })
    expect(arm).toMatchObject({
      name: 'entra_arm',
      hosts: ['management.azure.com'],
      mint: { scope: 'https://management.azure.com/.default' },
    })
    expect(expanded('microsoft_entra', ['key_vault'], ENTRA_FIELDS)).toHaveLength(1)
    expect(expanded('jira', [], { site: 'Your-Domain' })[0]?.hosts).toEqual(['your-domain.atlassian.net'])
  })

  it('merges the Google APIs picked into one connection, with the user to act as', () => {
    const [mail] = expanded('google_service_account', ['gmail', 'drive', 'calendar'], { subject: 'Ann@Example.com' })
    expect(mail).toMatchObject({
      name: 'google',
      env: 'GOOGLE_ACCESS_TOKEN',
      kind: 'jwt_bearer',
      hosts: ['gmail.googleapis.com', 'www.googleapis.com'],
      mint: {
        token_url: 'https://oauth2.googleapis.com/token',
        subject: 'ann@example.com',
        issuer: null,
        scope: [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/drive.readonly',
          'https://www.googleapis.com/auth/calendar.readonly',
        ].join(' '),
      },
    })
    const [writer] = expanded('google_service_account', ['gmail', 'drive'], {}, { write: ['gmail', 'sheets'] })
    expect(writer?.mint?.scope).toBe(
      'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/drive.readonly',
    )
    expect(expanded('microsoft_entra', ['graph'], ENTRA_FIELDS, { write: ['graph'] })[0]?.mint?.scope).toBe(
      'https://graph.microsoft.com/.default',
    )
    const [cloud] = expanded('google_service_account', ['sheets', 'cloud_platform'])
    expect(cloud?.hosts).toEqual(['*.googleapis.com'])
    expect(cloud?.mint?.subject).toBeNull()
  })

  it('says what is missing instead of making a connection', () => {
    const entra = templateOf('microsoft_entra')
    const expand = (parts: string[], fields: Record<string, string>) => expandTemplate(entra, { parts, fields }, NONE)
    expect(expand(['graph'], {})).toEqual({ error: 'Enter the Directory (tenant) ID' })
    expect(expand(['graph'], { tenant: 'contoso', client_id: APP })).toHaveProperty('error')
    expect(expand([], ENTRA_FIELDS)).toEqual({ error: 'Pick at least one API' })
    expect(expand(['mail'], ENTRA_FIELDS)).toEqual({ error: 'Microsoft Entra app has no mail' })
    expect(templateValues(entra, { key_file: 'x' })).toHaveProperty('error')
    expect(templateValues(entra, { tenant: 'x' })).toHaveProperty('error')
  })

  it('steps around names and variables already in use', () => {
    const taken = { names: new Set(['entra_graph', 'openai']), envs: new Set(['ENTRA_GRAPH', 'OPENAI_API_KEY']) }
    const [graph, arm] = expanded('microsoft_entra', ['graph', 'arm'], ENTRA_FIELDS, { taken })
    expect([graph?.name, graph?.env, arm?.name]).toEqual(['entra_graph_2', 'ENTRA_GRAPH_2', 'entra_arm'])
    expect(expanded('openai', [], {}, { taken })[0]).toMatchObject({ name: 'openai_2', env: 'OPENAI_API_KEY_2' })
  })

  it('makes the Gemini API key a connection Gemini agents take their key from', () => {
    const [gemini] = expanded('gemini', [])
    expect(gemini).toMatchObject({ header: { name: 'x-goog-api-key', template: '{{value}}' } })
    expect(reachesProvider(providerOf('gemini'), gemini?.hosts ?? [])).toBe(true)
    expect(CONNECTION_TEMPLATES.filter((entry) => templateMatches(entry, 'gemini')).map((entry) => entry.id)).toEqual([
      'gemini',
    ])
  })

  it('finds a template by its name, its hosts or one of its APIs', () => {
    const found = (query: string) => CONNECTION_TEMPLATES.filter((entry) => templateMatches(entry, query))
    expect(found('')).toHaveLength(CONNECTION_TEMPLATES.length)
    expect(found('azure').map((entry) => entry.id)).toEqual(['microsoft_entra'])
    expect(found('gmail').map((entry) => entry.id)).toEqual(['google_service_account'])
    expect(found('api.stripe.com').map((entry) => entry.id)).toEqual(['stripe'])
  })
})

describe('POST /connections/from-template', () => {
  it('adds every connection of a template with its secret, and audits the template and no value', async () => {
    const res = await post({
      template: 'microsoft_entra',
      parts: ['graph', 'arm'],
      fields: ENTRA_FIELDS,
      values: { client_secret: SECRET },
      profile_ids: ['default'],
    })
    expect(res.status, res.text).toBe(200)
    expect(res.text).not.toContain(SECRET)
    const made = (JSON.parse(res.text) as { data: Connection[] }).data
    expect(made.map((connection) => [connection.name, connection.hosts, connection.missing])).toEqual([
      ['entra_graph', ['graph.microsoft.com'], []],
      ['entra_arm', ['management.azure.com'], []],
    ])
    expect(made[0]?.profiles).toEqual([{ id: 'default', name: 'Default' }])
    const audited = await auditEvents.latest('system.connection_created')
    expect(audited).toMatchObject({
      actor: 'user',
      summary: 'Added the connection entra_arm for management.azure.com from the template microsoft_entra',
      detail: { template: 'microsoft_entra', values: ['client_secret'], credentials: ['Default'] },
    })
    expect(JSON.stringify(audited)).not.toContain(SECRET)

    const again = await post({ template: 'microsoft_entra', parts: ['graph'], fields: ENTRA_FIELDS })
    const [second] = (JSON.parse(again.text) as { data: Connection[] }).data
    expect(second).toMatchObject({ name: 'entra_graph_2', env: 'ENTRA_GRAPH_2', missing: ['client_secret'] })
  })

  it('adds a key service with its header, waiting for its key', async () => {
    const res = await post({ template: 'elevenlabs' })
    expect(res.status, res.text).toBe(200)
    expect((JSON.parse(res.text) as { data: Connection[] }).data).toMatchObject([
      {
        name: 'elevenlabs',
        env: 'ELEVENLABS_API_KEY',
        hosts: ['api.elevenlabs.io'],
        header: { name: 'xi-api-key', template: '{{value}}' },
        missing: ['value'],
      },
    ])
  })

  it('adds nothing when a part of the request is wrong', async () => {
    const entra = { template: 'microsoft_entra', parts: ['graph', 'arm'], fields: ENTRA_FIELDS }
    expect((await post({ ...entra, profile_ids: ['no-such-credential'] })).status).toBe(404)
    expect((await post({ ...entra, fields: { tenant: 'contoso', client_id: APP } })).status).toBe(400)
    expect((await post({ ...entra, values: { key: SECRET } })).status).toBe(400)
    expect((await post({ template: 'no_such_service' })).status).toBe(404)
    const google = { template: 'google_service_account', parts: ['drive'], values: { key_file: 'not a key file' } }
    expect((await post(google)).status).toBe(400)
    expect(await listed()).toEqual([])
  })

  it('refuses the EA', async () => {
    expect((await post({ template: 'openai' }, EA_AUTH)).status).toBe(403)
    expect(await listed()).toEqual([])
  })
})
