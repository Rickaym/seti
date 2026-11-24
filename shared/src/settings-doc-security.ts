import { z } from 'zod'
import { awsSettingsInput } from './aws.js'
import { CONNECTION_KINDS, connectionHeader, mintSettingsInput } from './connections.js'
import { DEVICE_PLATFORMS, DEVICE_SCOPES } from './devices.js'
import { permissionTimeoutInput } from './permission-timeout.js'
import { sandboxPolicyInput } from './sandbox.js'
import { documented, keyedBy, secretState, settingsSection } from './settings-doc.js'
import { sshHostFields } from './ssh.js'

const mcpServers = settingsSection({
  page: 'mcp',
  description: 'MCP servers agents can use',
  schema: documented(
    { defaults: keyedBy(z.boolean()) },
    { defaults: 'Whether each server is on for a new agent, by server name' },
  ),
  security: [],
})

const plugins = settingsSection({
  page: 'plugins',
  description: 'Plugin folders Seti gives agents',
  schema: documented(
    {
      folders: keyedBy(
        documented(
          { name: z.string(), path: z.string(), enabled: z.boolean() },
          { name: 'Its name', path: 'The folder on this machine', enabled: 'On for new agents' },
        ),
      ),
    },
    { folders: 'Each plugin folder by its id' },
  ),
  security: [],
})

const signIn = settingsSection({
  page: 'signin',
  description: 'Who may sign in to Seti',
  schema: documented(
    {
      require_passkey: z.boolean(),
      passkeys: z.array(z.string()),
      devices: z.array(
        documented(
          { name: z.string(), platform: z.enum(DEVICE_PLATFORMS), scopes: z.array(z.enum(DEVICE_SCOPES)) },
          { name: 'Its name', platform: 'What it runs on', scopes: 'What it may read' },
        ),
      ),
    },
    {
      require_passkey: 'Browsers sign in with a passkey',
      passkeys: 'Your passkeys, by name',
      devices: 'Paired devices, such as a phone widget',
    },
  ),
  security: 'all',
})

const sandbox = settingsSection({
  page: 'sandbox',
  description: 'The sandbox agents run in and the hosts they may reach',
  schema: documented(
    {
      enabled: sandboxPolicyInput.shape.enabled,
      allowed_domains: sandboxPolicyInput.shape.allowed_domains,
      hidden_paths: sandboxPolicyInput.shape.hidden_paths,
    },
    {
      enabled: 'Agents run sandboxed; off gives them your full access to this machine',
      allowed_domains: 'Hosts every sandboxed agent may reach, exact or *.suffix',
      hidden_paths: 'Paths hidden from every sandboxed agent, besides the built-in ones',
    },
  ),
  security: 'all',
})

const rules = documented(
  { allow: z.array(z.string()), ask: z.array(z.string()), deny: z.array(z.string()), review: z.array(z.string()) },
  {
    allow: 'Calls that run without asking',
    ask: 'Calls that always ask you',
    deny: 'Calls that are refused',
    review: 'Tool-server calls held for your review, even in bypass',
  },
)

const permissions = settingsSection({
  page: 'permissions',
  description: 'Rules for what agents may do without asking',
  schema: documented(
    { request_timeout_minutes: permissionTimeoutInput.shape.request_timeout_minutes, rules },
    {
      request_timeout_minutes: 'Minutes before an unanswered request is denied; 0 never times out',
      rules: 'Rules for every agent, by what they decide',
    },
  ),
  security: 'all',
})

const mint = mintSettingsInput.shape

const mintDoc = documented(
  {
    token_url: mint.token_url,
    client_id: mint.client_id,
    client_auth: mint.client_auth,
    key_id: mint.key_id,
    certificate_thumbprint: mint.certificate_thumbprint,
    issuer: mint.issuer,
    subject: mint.subject,
    scope: mint.scope,
    audience: mint.audience,
    resource: mint.resource,
    extra_params: mint.extra_params,
  },
  {
    token_url: 'Where Seti asks for a token, over https',
    client_id: 'The client id when it is not secret',
    client_auth: 'How Seti proves the client to the token URL',
    key_id: 'The id of the signing key, when the service needs it',
    certificate_thumbprint: "An Entra certificate's SHA-1 thumbprint",
    issuer: 'Who signs the assertion; null for a key file that names its own',
    subject: 'Whom the assertion acts for; empty for the issuer',
    scope: 'The scopes asked for',
    audience: 'The audience asked for',
    resource: 'The resource asked for',
    extra_params: 'More parameters sent with each mint',
  },
)

const headerDoc = documented(
  { name: connectionHeader.shape.name, template: connectionHeader.shape.template },
  { name: 'The header name', template: 'Its value, with the placeholder where the secret goes' },
)

const aws = awsSettingsInput.shape

const awsDoc = documented(
  { role_arn: aws.role_arn, external_id: aws.external_id, region: aws.region, session_minutes: aws.session_minutes },
  {
    role_arn: 'The role agents assume; null for no AWS access',
    external_id: "The external id the role's trust policy asks for; null for none",
    region: 'The region agents work in',
    session_minutes: 'How long a session lasts, 15 to 720 minutes',
  },
)

const connection = documented(
  {
    kind: z.enum(CONNECTION_KINDS),
    env: z.string(),
    hosts: z.array(z.string()),
    header: headerDoc.nullable(),
    mint: mintDoc.nullable(),
    body: z.boolean(),
    values: keyedBy(secretState),
  },
  {
    kind: 'A key, or how Seti mints a token',
    env: 'The variable agents read its placeholder from',
    hosts: 'Hosts the proxy adds it on',
    header: 'The header the proxy adds, as a template; null puts it in the variable only',
    mint: 'How Seti mints a token; null for a plain key',
    body: 'Whether the proxy also swaps the value into request bodies on its hosts',
    values: 'Whether each value is set; values never appear here',
  },
)

const connections = settingsSection({
  page: 'connections',
  description: 'Access to one service each, which credentials carry',
  schema: documented({ connections: keyedBy(connection) }, { connections: 'Each connection by its name' }),
  security: 'all',
})

const credential = documented(
  {
    aws: awsDoc,
    github: documented(
      { default: secretState, owners: keyedBy(secretState) },
      { default: 'The token for requests that name no owner', owners: 'Tokens per owner' },
    ),
    connections: z.array(z.string()),
    ssh_hosts: z.array(z.string()),
  },
  {
    aws: 'The AWS role agents assume',
    github: 'Whether code-host tokens are set; tokens never appear here',
    connections: 'Connections it carries, by name',
    ssh_hosts: 'SSH hosts it carries, by alias',
  },
)

const credentials = settingsSection({
  page: 'credentials',
  description: 'The bundles of access an agent picks',
  schema: documented(
    {
      credentials: keyedBy(credential),
      agent_tokens: keyedBy(secretState),
      default_access: keyedBy(z.boolean()),
    },
    {
      credentials: 'Each credential by its name',
      agent_tokens: 'Whether each token every agent uses is set, such as claude_oauth_token',
      default_access: 'Cloud access on for a new agent, by item',
    },
  ),
  security: 'all',
})

const sshHost = documented(
  {
    hostname: sshHostFields.shape.hostname,
    port: sshHostFields.shape.port,
    user: sshHostFields.shape.user,
    key: z.string().nullable(),
    jump: sshHostFields.shape.jump,
  },
  {
    hostname: 'The address ssh connects to',
    port: 'Its port',
    user: 'The user to log in as',
    key: 'The key it logs in with, by name; keys never appear here',
    jump: 'The host it connects through first; null for none',
  },
)

const ssh = settingsSection({
  page: 'ssh',
  description: 'SSH hosts and keys agents may use',
  schema: documented(
    { hosts: keyedBy(sshHost), keys: z.array(z.string()), default_access: keyedBy(z.boolean()) },
    {
      hosts: 'Each host by its alias',
      keys: 'Your keys, by name',
      default_access: 'Whether each host is on for a new agent, by alias',
    },
  ),
  security: 'all',
})

const sharing = settingsSection({
  page: 'sharing',
  description: 'Public links to a frozen copy of one file',
  schema: documented({ enabled: z.boolean() }, { enabled: 'Agents and you may make share links' }),
  security: 'all',
})

/** The Capabilities and Security groups. */
export const SECURITY_SECTIONS = {
  'capabilities.mcp_servers': mcpServers,
  'capabilities.plugins': plugins,
  'security.sign_in': signIn,
  'security.sandbox': sandbox,
  'security.permissions': permissions,
  'security.connections': connections,
  'security.credentials': credentials,
  'security.ssh': ssh,
  'security.sharing': sharing,
} as const
