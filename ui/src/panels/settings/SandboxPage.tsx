import {
  DEFAULT_ALLOWED_DOMAINS,
  sandboxPolicyInput,
  type ClaudeCredentialMode,
  type GitHubTokenMode,
  type SandboxPolicyInput,
  type SandboxStatus,
} from '@seti/shared'
import { RotateCcw, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPut, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useLeaveGuard } from '@/hooks/useLeaveGuard'
import { refreshSystem } from '@/hooks/useSystem'
import { SandboxMcpCard } from './SandboxMcpCard'
import { SettingRow, SettingsBody, SettingsCard, SettingsHeader } from './layout'

const TOKEN_TEXT: Record<GitHubTokenMode, string> = {
  agent: 'Fine-grained token',
  none: 'None',
}

function tokenHint(status: SandboxStatus): string {
  switch (status.token_mode) {
    case 'agent':
      return "The GitHub token from Credentials. Agents hold a placeholder; Seti's proxy puts the token on GitHub requests."
    case 'none':
      return 'Agents reach GitHub anonymously. Set a fine-grained GitHub token in Credentials to let them use chosen repos.'
  }
}

const CLAUDE_TEXT: Record<ClaudeCredentialMode, string> = {
  token: 'Long-lived token',
  login: 'Host login',
  none: 'None',
}

function claudeHint(status: SandboxStatus): string {
  switch (status.claude_credential) {
    case 'token':
      return "The Claude token from Credentials. Agents hold a placeholder; Seti's proxy adds the token."
    case 'login':
      return 'The Claude Code login on this machine. Set a claude setup-token token in Credentials to stop depending on it.'
    case 'none':
      return 'Log in with claude on this machine or set a Claude token in Credentials; until then agents cannot reach Claude.'
  }
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

interface Form {
  enabled: boolean
  domains: string
  hidden: string
}

const toForm = (status: SandboxStatus): Form => ({
  enabled: status.policy.enabled,
  domains: status.policy.allowed_domains.join('\n'),
  hidden: status.policy.hidden_paths.join('\n'),
})

const sameForm = (a: Form, b: Form) => a.enabled === b.enabled && a.domains === b.domains && a.hidden === b.hidden

function SandboxForm({ status, onSaved }: { status: SandboxStatus; onSaved: (next: SandboxStatus) => void }) {
  const [form, setForm] = useState<Form>(() => toForm(status))
  const [saving, setSaving] = useState(false)
  const dirty = !sameForm(form, toForm(status))
  useLeaveGuard(dirty)
  const patch = (next: Partial<Form>) => {
    setForm((prev) => ({ ...prev, ...next }))
  }

  const save = async () => {
    const input: SandboxPolicyInput = {
      enabled: form.enabled,
      allowed_domains: lines(form.domains),
      hidden_paths: lines(form.hidden),
    }
    const parsed = sandboxPolicyInput.safeParse(input)
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the lists')
      return
    }
    setSaving(true)
    try {
      const saved = await apiPut<SandboxStatus>('/sandbox', input)
      refreshSystem()
      toast.success('Sandbox saved')
      onSaved(saved)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsBody
      narrow
      header={
        <SettingsHeader
          title="Sandbox"
          description="What agents may read and write, which hosts they reach and which credentials Seti adds for them."
          actions={
            <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
              <Save />
              {saving ? 'Saving...' : 'Save'}
            </Button>
          }
        />
      }
    >
      <div className="space-y-4">
        <SettingsCard title="Agent sandbox">
          <SettingRow
            label="Sandbox agents"
            description={
              form.enabled
                ? 'Each agent runs in its own bubblewrap sandbox: it sees only its directories, holds no credentials and reaches only the listed hosts.'
                : 'Agents run every command with full access to this machine and the network.'
            }
          >
            <Switch
              aria-label="Sandbox agents"
              checked={form.enabled}
              onCheckedChange={(enabled) => {
                patch({ enabled })
              }}
            />
          </SettingRow>
          <SettingRow label="Claude access" description={claudeHint(status)}>
            <span className="font-medium">{CLAUDE_TEXT[status.claude_credential]}</span>
          </SettingRow>
          <SettingRow label="GitHub token" description={tokenHint(status)}>
            <span className="font-medium">{TOKEN_TEXT[status.token_mode]}</span>
          </SettingRow>
        </SettingsCard>
        <SettingsCard
          title="Allowed hosts"
          actions={
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                patch({ domains: DEFAULT_ALLOWED_DOMAINS.join('\n') })
              }}
            >
              <RotateCcw />
              Defaults
            </Button>
          }
        >
          <div className="space-y-1.5 p-3">
            <Textarea
              aria-label="Allowed hosts"
              className="max-h-96 font-mono"
              rows={12}
              value={form.domains}
              onChange={(e) => {
                patch({ domains: e.target.value })
              }}
            />
            <p className="text-2xs text-muted-foreground">
              One per line; *.example.com for subdomains. Claude itself is always reachable.
            </p>
          </div>
        </SettingsCard>
        <SandboxMcpCard servers={status.mcp_servers} />
        <SettingsCard title="Hidden paths">
          <div className="space-y-1.5 p-3">
            <Textarea
              aria-label="Hidden paths"
              className="max-h-40 font-mono"
              rows={4}
              value={form.hidden}
              placeholder="~/wg0.conf"
              onChange={(e) => {
                patch({ hidden: e.target.value })
              }}
            />
            <p className="text-2xs text-muted-foreground">
              Extra files or folders no agent reads. Always hidden: {status.built_in_hidden.join(', ')}.
            </p>
          </div>
        </SettingsCard>
      </div>
    </SettingsBody>
  )
}

export function SandboxPage() {
  const [status, setStatus] = useState<SandboxStatus | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    apiGet<SandboxStatus>('/sandbox').then(setStatus, (e: unknown) => {
      setError(errorText(e))
    })
  }, [])
  if (status === null) {
    return (
      <SettingsBody narrow header={<SettingsHeader title="Sandbox" />}>
        <p className={error === '' ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>
          {error === '' ? 'Loading...' : error}
        </p>
      </SettingsBody>
    )
  }
  return <SandboxForm key={status.policy.updated_at ?? 'default'} status={status} onSaved={setStatus} />
}
