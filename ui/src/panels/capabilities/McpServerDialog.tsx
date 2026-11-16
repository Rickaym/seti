import {
  MCP_ADD_TRANSPORTS,
  MCP_CONFIG_SCOPES,
  mcpServerInput,
  type McpAddTransport,
  type McpConfigScope,
  type McpConnector,
  type McpServerChange,
  type McpServerInput,
  type Repo,
} from '@seti/shared'
import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, errorText } from '@/api'
import { CrudEditDialog, Field } from '@/components/crud/CrudForm'
import { FindableTextarea } from '@/components/find/FindableTextarea'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { OAuthFields, type OAuthForm } from './OAuthFields'
import { PairRows } from './PairRows'
import { newPair, type Pair } from './pairs'

const HOME = '__home__'

const SCOPE_LABEL: Record<McpConfigScope, string> = {
  user: 'User: every project, only you',
  local: 'Local: one directory, only you',
  project: 'Project: .mcp.json in a repo, shared',
}

const TRANSPORT_LABEL: Record<McpAddTransport, string> = {
  http: 'HTTP (streamable)',
  sse: 'SSE',
  stdio: 'stdio (local command)',
}

interface Form extends OAuthForm {
  name: string
  transport: McpAddTransport
  scope: McpConfigScope
  location: string
  url: string
  command: string
  args: string
  pairs: Pair[]
}

function toInput(form: Form): McpServerInput {
  const pairs = form.pairs
    .filter((p) => p.key.trim() !== '' || p.value !== '')
    .map((p) => ({ key: p.key.trim(), value: p.value }))
  const where = {
    name: form.name,
    scope: form.scope,
    ...(form.scope === 'user' || form.location === HOME || form.location === '' ? {} : { repo_id: form.location }),
  }
  if (form.transport === 'stdio') {
    const args = form.args.split('\n').filter((arg) => arg.trim() !== '')
    return { ...where, transport: 'stdio', command: form.command, args, env: pairs }
  }
  return { ...where, transport: form.transport, url: form.url.trim(), headers: pairs, ...oauthOf(form) }
}

function oauthOf(form: Form): Pick<McpServerInput & { transport: 'http' }, 'oauth'> {
  const clientId = form.clientId.trim()
  if (clientId === '') {
    return {}
  }
  const port = form.callbackPort.trim()
  return {
    oauth: {
      client_id: clientId,
      ...(form.clientSecret === '' ? {} : { client_secret: form.clientSecret }),
      ...(port === '' ? {} : { callback_port: Number(port) }),
    },
  }
}

const BLANK: McpConnector = {
  id: '',
  name: '',
  title: '',
  description: '',
  source: 'common',
  transport: 'http',
  url: '',
  command: '',
  args: [],
  fields: [],
  oauth: null,
  plugin: null,
  homepage: null,
  note: '',
}

/** The form a picked connector starts: its launch, its named fields and its OAuth needs. */
function initialForm(preset: McpConnector, location: string): Form {
  const pairs = preset.fields.map((f) => newPair(f.key, f.value, f.description))
  const port = preset.oauth?.callback_port ?? null
  return {
    name: preset.name,
    transport: preset.transport,
    scope: 'user',
    location,
    url: preset.url,
    command: preset.command,
    args: preset.args.join('\n'),
    pairs: pairs.length === 0 ? [newPair()] : pairs,
    clientId: '',
    clientSecret: '',
    callbackPort: port === null ? '' : String(port),
  }
}

function LocationField({ form, set, repos }: { form: Form; set: (patch: Partial<Form>) => void; repos: Repo[] }) {
  if (form.scope === 'user') {
    return null
  }
  return (
    <Field label={form.scope === 'project' ? 'Repo' : 'Directory'}>
      <Select
        value={form.location}
        onValueChange={(location) => {
          set({ location })
        }}
      >
        <SelectTrigger aria-label="Location" className="w-full">
          <SelectValue placeholder="Pick a repo" />
        </SelectTrigger>
        <SelectContent>
          {form.scope === 'local' && <SelectItem value={HOME}>Home directory</SelectItem>}
          {repos.map((repo) => (
            <SelectItem key={repo.id} value={repo.id}>
              {repo.slug}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

function TransportFields({ form, set }: { form: Form; set: (patch: Partial<Form>) => void }) {
  if (form.transport !== 'stdio') {
    return (
      <>
        <Field label="URL" full>
          <Input
            aria-label="URL"
            value={form.url}
            onChange={(e) => {
              set({ url: e.target.value })
            }}
            placeholder="https://cloud.langfuse.com/api/public/mcp"
          />
        </Field>
        <PairRows
          label="Headers"
          item="header"
          pairs={form.pairs}
          keyPlaceholder="Authorization"
          valuePlaceholder="Basic base64(pk-lf-...:sk-lf-...)"
          onChange={(pairs) => {
            set({ pairs })
          }}
        />
      </>
    )
  }
  return (
    <>
      <Field label="Command" full>
        <Input
          aria-label="Command"
          value={form.command}
          onChange={(e) => {
            set({ command: e.target.value })
          }}
          placeholder="npx"
        />
      </Field>
      <Field label="Arguments" full>
        <FindableTextarea
          aria-label="Arguments"
          rows={3}
          value={form.args}
          onChange={(e) => {
            set({ args: e.target.value })
          }}
          placeholder={'One per line, such as\n-y\n@modelcontextprotocol/server-everything'}
        />
      </Field>
      <PairRows
        label="Environment variables"
        item="variable"
        pairs={form.pairs}
        keyPlaceholder="API_KEY"
        valuePlaceholder="value"
        onChange={(pairs) => {
          set({ pairs })
        }}
      />
    </>
  )
}

export function McpServerDialog({
  repoId,
  preset,
  onClose,
  onSaved,
}: {
  repoId: string | undefined
  /** The connector the form starts from; a blank form without one. */
  preset?: McpConnector | undefined
  onClose: () => void
  onSaved: (change: McpServerChange) => void
}) {
  const [repos, setRepos] = useState<Repo[]>([])
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<Form>(() => initialForm(preset ?? BLANK, repoId ?? HOME))

  useEffect(() => {
    apiGet<Repo[]>('/repos')
      .then(setRepos)
      .catch((e: unknown) => toast.error(errorText(e)))
  }, [])

  const set = (patch: Partial<Form>) => {
    setForm((prev) => ({ ...prev, ...patch }))
  }

  const save = async () => {
    const parsed = mcpServerInput.safeParse(toInput(form))
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the form')
      return
    }
    setSaving(true)
    try {
      onSaved(await apiPost<McpServerChange>('/mcp/servers', toInput(form)))
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <CrudEditDialog
      open
      title={preset === undefined ? 'Add MCP server' : `Add ${preset.title}`}
      onCancel={onClose}
      onSave={() => void save()}
      saving={saving}
      saveLabel="Add"
      savingLabel="Adding..."
      saveIcon={Plus}
    >
      {preset !== undefined && preset.note !== '' && (
        <p className="col-span-full text-xs text-muted-foreground">{preset.note}</p>
      )}
      <Field label="Name">
        <Input
          aria-label="Name"
          value={form.name}
          onChange={(e) => {
            set({ name: e.target.value })
          }}
          placeholder="langfuse"
        />
      </Field>
      <Field label="Transport">
        <Select
          value={form.transport}
          onValueChange={(value) => {
            const transport = MCP_ADD_TRANSPORTS.find((t) => t === value) ?? 'http'
            set({ transport, pairs: [newPair()] })
          }}
        >
          <SelectTrigger aria-label="Transport" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MCP_ADD_TRANSPORTS.map((t) => (
              <SelectItem key={t} value={t}>
                {TRANSPORT_LABEL[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Config scope">
        <Select
          value={form.scope}
          onValueChange={(value) => {
            const scope = MCP_CONFIG_SCOPES.find((s) => s === value) ?? 'user'
            const location = scope === 'project' && form.location === HOME ? '' : form.location
            set({ scope, location })
          }}
        >
          <SelectTrigger aria-label="Config scope" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MCP_CONFIG_SCOPES.map((s) => (
              <SelectItem key={s} value={s}>
                {SCOPE_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <LocationField form={form} set={set} repos={repos} />
      <TransportFields form={form} set={set} />
      {form.transport !== 'stdio' && <OAuthFields form={form} set={set} open={preset?.oauth?.own_client === true} />}
      <p className="col-span-full text-xs text-muted-foreground">
        Runs <code>claude mcp add</code>. Header, environment and client secret values are written to the Claude Code
        config and never shown again here.
      </p>
    </CrudEditDialog>
  )
}
