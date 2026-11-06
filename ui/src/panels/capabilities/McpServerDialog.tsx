import {
  MCP_ADD_TRANSPORTS,
  MCP_CONFIG_SCOPES,
  mcpServerInput,
  type McpAddTransport,
  type McpConfigScope,
  type McpServerChange,
  type McpServerInput,
  type Repo,
} from '@seti/shared'
import { Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, errorText } from '@/api'
import { CrudEditDialog, Field } from '@/components/crud/CrudForm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

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

interface Pair {
  id: number
  key: string
  value: string
}

interface Form {
  name: string
  transport: McpAddTransport
  scope: McpConfigScope
  location: string
  url: string
  command: string
  args: string
  pairs: Pair[]
}

let nextPairId = 0
const newPair = (): Pair => {
  nextPairId += 1
  return { id: nextPairId, key: '', value: '' }
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
  return { ...where, transport: form.transport, url: form.url.trim(), headers: pairs }
}

function PairRows({
  label,
  item,
  pairs,
  keyPlaceholder,
  valuePlaceholder,
  onChange,
}: {
  label: string
  /** One row's name on the add button, kept to a word. */
  item: string
  pairs: Pair[]
  keyPlaceholder: string
  valuePlaceholder: string
  onChange: (pairs: Pair[]) => void
}) {
  const update = (id: number, patch: Partial<Pair>) => {
    onChange(pairs.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }
  return (
    <div className="col-span-full grid gap-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {pairs.map((pair, i) => (
        <div key={pair.id} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] gap-2">
          <Input
            aria-label={`${label} ${String(i + 1)} name`}
            placeholder={keyPlaceholder}
            value={pair.key}
            onChange={(e) => {
              update(pair.id, { key: e.target.value })
            }}
          />
          <Input
            aria-label={`${label} ${String(i + 1)} value`}
            type="password"
            autoComplete="off"
            placeholder={valuePlaceholder}
            value={pair.value}
            onChange={(e) => {
              update(pair.id, { value: e.target.value })
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${label.toLowerCase()} ${String(i + 1)}`}
            onClick={() => {
              onChange(pairs.filter((p) => p.id !== pair.id))
            }}
          >
            <X />
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label={`Add ${label.toLowerCase().replace(/s$/, '')}`}
          onClick={() => {
            onChange([...pairs, newPair()])
          }}
        >
          <Plus />
          Add {item}
        </Button>
      </div>
    </div>
  )
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
        <Textarea
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
  onClose,
  onSaved,
}: {
  repoId: string | undefined
  onClose: () => void
  onSaved: (change: McpServerChange) => void
}) {
  const [repos, setRepos] = useState<Repo[]>([])
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<Form>(() => ({
    name: '',
    transport: 'http',
    scope: 'user',
    location: repoId ?? HOME,
    url: '',
    command: '',
    args: '',
    pairs: [newPair()],
  }))

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
      title="Add MCP server"
      onCancel={onClose}
      onSave={() => void save()}
      saving={saving}
      saveLabel="Add"
      savingLabel="Adding..."
      saveIcon={Plus}
    >
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
      <p className="col-span-full text-xs text-muted-foreground">
        Runs <code>claude mcp add</code>. Header and environment values are written to the Claude Code config and never
        shown again here.
      </p>
    </CrudEditDialog>
  )
}
