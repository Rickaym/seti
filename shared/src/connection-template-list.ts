import { KEY_SERVICE_TEMPLATES } from './connection-key-services.js'
import type { ConnectionTemplate, ConnectionTemplatePart } from './connection-templates.js'

const googleScopes = (...names: string[]) => names.map((name) => `https://www.googleapis.com/auth/${name}`).join(' ')

const GOOGLE_PARTS: ConnectionTemplatePart[] = [
  {
    id: 'admin_directory',
    title: 'Admin directory',
    description: 'Users and groups of a Workspace domain.',
    hosts: ['admin.googleapis.com'],
    scope: googleScopes('admin.directory.user.readonly', 'admin.directory.group.readonly'),
    write_scope: googleScopes('admin.directory.user', 'admin.directory.group'),
  },
  {
    id: 'gmail',
    title: 'Gmail',
    description: 'Mail and labels; with Write also send and change mail, without permanent deletion.',
    hosts: ['gmail.googleapis.com'],
    scope: googleScopes('gmail.readonly'),
    write_scope: googleScopes('gmail.modify'),
  },
  {
    id: 'drive',
    title: 'Drive',
    description: 'Every file of the account.',
    hosts: ['www.googleapis.com'],
    scope: googleScopes('drive.readonly'),
    write_scope: googleScopes('drive'),
  },
  {
    id: 'sheets',
    title: 'Sheets',
    description: 'Spreadsheets and their values.',
    hosts: ['sheets.googleapis.com'],
    scope: googleScopes('spreadsheets.readonly'),
    write_scope: googleScopes('spreadsheets'),
  },
  {
    id: 'calendar',
    title: 'Calendar',
    description: 'Calendars and events.',
    hosts: ['www.googleapis.com'],
    scope: googleScopes('calendar.readonly'),
    write_scope: googleScopes('calendar'),
  },
  {
    id: 'cloud_platform',
    title: 'Cloud Platform',
    description: 'Every Google Cloud API the account has roles for.',
    hosts: ['*.googleapis.com'],
    scope: googleScopes('cloud-platform.read-only'),
    write_scope: googleScopes('cloud-platform'),
  },
]

const storageHosts = ['blob', 'dfs', 'file', 'queue', 'table'].map((service) => `*.${service}.core.windows.net`)

const ENTRA_PARTS: ConnectionTemplatePart[] = [
  {
    id: 'graph',
    title: 'Microsoft Graph',
    description: 'Users, mail, calendars, files and Teams, by the app permissions granted.',
    hosts: ['graph.microsoft.com'],
    scope: 'https://graph.microsoft.com/.default',
    write_scope: null,
  },
  {
    id: 'arm',
    title: 'Azure Resource Manager',
    description: 'Subscriptions and resources, by the roles assigned to the app.',
    hosts: ['management.azure.com'],
    scope: 'https://management.azure.com/.default',
    write_scope: null,
  },
  {
    id: 'key_vault',
    title: 'Key Vault',
    description: 'Secrets, keys and certificates of the vaults the app may read.',
    hosts: ['*.vault.azure.net'],
    scope: 'https://vault.azure.net/.default',
    write_scope: null,
  },
  {
    id: 'storage',
    title: 'Azure Storage',
    description: 'Blobs, files, queues and tables, by the data roles assigned to the app.',
    hosts: storageHosts,
    scope: 'https://storage.azure.com/.default',
    write_scope: null,
  },
]

const ENTRA: ConnectionTemplate = {
  id: 'microsoft_entra',
  title: 'Microsoft Entra app',
  description: 'An app registration with a client secret, for Microsoft Graph and Azure.',
  category: 'cloud',
  docs: 'https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow',
  fields: [
    {
      key: 'tenant',
      label: 'Directory (tenant) ID',
      help: 'On the app registration Overview page. The tenant of an az ad sp create-for-rbac result.',
      placeholder: '0000aaaa-11bb-22cc-33dd-444444eeeeee',
      slot: null,
      format: 'guid',
      required: true,
    },
    {
      key: 'client_id',
      label: 'Application (client) ID',
      help: 'On the same Overview page. The appId of an az ad sp create-for-rbac result.',
      placeholder: '1111bbbb-22cc-33dd-44ee-555555ffffff',
      slot: null,
      format: 'guid',
      required: true,
    },
    {
      key: 'client_secret',
      label: 'Client secret',
      help: 'The Value of a secret under Certificates and secrets, not its Secret ID. The password of an az result.',
      placeholder: 'Paste it now or later',
      slot: 'client_secret',
      format: 'text',
      required: false,
    },
  ],
  name: 'entra',
  env: null,
  kind: 'client_credentials',
  hosts: [],
  header: { name: 'Authorization', template: 'Bearer {{value}}' },
  mint: {
    token_url: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
    client_id: '{client_id}',
    client_auth: 'client_secret_post',
    subject: null,
  },
  parts: ENTRA_PARTS,
  parts_mode: 'each',
  note: 'A token is for one API, so each API ticked is its own connection with the same app.',
}

const GOOGLE: ConnectionTemplate = {
  id: 'google_service_account',
  title: 'Google service account',
  description: 'A service account key file, for Google Workspace and Google Cloud APIs.',
  category: 'cloud',
  docs: 'https://developers.google.com/identity/protocols/oauth2/service-account',
  fields: [
    {
      key: 'key_file',
      label: 'Key file',
      help: 'The JSON key created under the service account, Keys, Add key.',
      placeholder: 'Paste the JSON now or later',
      slot: 'key_file',
      format: 'text',
      required: false,
    },
    {
      key: 'subject',
      label: 'Act as user',
      help: 'For domain-wide delegation: the Workspace user to act as. Empty to act as the service account.',
      placeholder: 'Optional: user@example.com',
      slot: null,
      format: 'email',
      required: false,
    },
  ],
  name: 'google',
  env: 'GOOGLE_ACCESS_TOKEN',
  kind: 'jwt_bearer',
  hosts: [],
  header: { name: 'Authorization', template: 'Bearer {{value}}' },
  mint: {
    token_url: 'https://oauth2.googleapis.com/token',
    client_id: null,
    client_auth: 'client_secret_post',
    subject: '{subject}',
  },
  parts: GOOGLE_PARTS,
  parts_mode: 'merge',
  note: 'To act as a user, a Workspace admin allows these scopes for the service account under domain-wide delegation.',
}

/** Every service Seti can add by name, in the order the picker lists them. */
export const CONNECTION_TEMPLATES: readonly ConnectionTemplate[] = [ENTRA, GOOGLE, ...KEY_SERVICE_TEMPLATES]

export const connectionTemplate = (id: string): ConnectionTemplate | undefined =>
  CONNECTION_TEMPLATES.find((template) => template.id === id)
