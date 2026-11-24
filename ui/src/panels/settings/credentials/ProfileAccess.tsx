import type { AccessDefault, AccessItem, CredentialProfile, TaskAccessInput } from '@seti/shared'
import { Globe, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiGet, apiPost, apiPut, errorText } from '@/api'
import { InfoTip } from '@/components/InfoTip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AccessList } from '@/panels/access/AccessList'
import { SettingsCard } from '../layout'

const KINDS = ['aws', 'mcp', 'pack', 'plugin'] as const

/** The catalog as the credential sets it: its choice as the row's own, else the default. */
function itemsOf(catalog: readonly AccessDefault[], profile: CredentialProfile): AccessItem[] {
  const set = new Map(profile.access.items.map((entry) => [`${entry.kind}:${entry.id}`, entry.enabled]))
  return catalog.map((entry) => {
    const own = set.get(`${entry.kind}:${entry.id}`) ?? null
    return {
      ...entry,
      credential: null,
      override: own,
      enabled: own ?? entry.default_enabled,
      jump_for: [],
      missing_key: [],
      session: null,
      unusable: null,
    }
  })
}

function HostsRow({ profile, onChanged }: { profile: CredentialProfile; onChanged: () => void }) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await work()
      toast.success(done)
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const add = () => {
    const host = draft.trim()
    void run(async () => apiPost(`/credentials/profiles/${profile.id}/hosts`, { host }), `${host} added`).then(() => {
      setDraft('')
    })
  }
  return (
    <section aria-label="Hosts" className="flex min-w-0 flex-col gap-2 border-t border-border p-3 text-xs">
      <span className="flex items-center gap-1 text-2xs font-medium text-muted-foreground">
        <Globe className="size-3.5" aria-hidden />
        Hosts
        <InfoTip label="About hosts" text={`Agents using ${profile.name} reach these beside the shared allowlist.`} />
      </span>
      {profile.access.hosts.length > 0 && (
        <ul className="flex min-w-0 flex-wrap gap-1">
          {profile.access.hosts.map((host) => (
            <li key={host} className="flex min-w-0 items-center border border-border pl-1.5 text-2xs">
              <span className="truncate font-mono">{host}</span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${host}`}
                disabled={busy}
                className="text-muted-foreground pointer-coarse:size-9"
                onClick={() =>
                  void run(
                    async () => apiDelete(`/credentials/profiles/${profile.id}/hosts/${encodeURIComponent(host)}`),
                    `${host} removed`,
                  )
                }
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex min-w-0 gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          add()
        }}
      >
        <Input
          aria-label="Host to add"
          placeholder="api.example.com"
          className="min-w-0 flex-1"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
          }}
        />
        <Button type="submit" size="sm" variant="outline" disabled={busy || draft.trim() === ''}>
          <Plus />
          Add
        </Button>
      </form>
    </section>
  )
}

/** What agents using the credential get unless they choose their own, and hosts they reach. */
export function ProfileAccess({ profile, onChanged }: { profile: CredentialProfile; onChanged: () => void }) {
  const [catalog, setCatalog] = useState<AccessDefault[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    apiGet<AccessDefault[]>('/access').then(setCatalog, (e: unknown) => {
      toast.error(errorText(e))
    })
  }, [])
  const change = async (item: AccessItem, enabled: boolean | null) => {
    setBusy(`${item.kind}:${item.id}`)
    try {
      const body: TaskAccessInput = { kind: item.kind, id: item.id, enabled }
      await apiPut(`/credentials/profiles/${profile.id}/access`, body)
      toast.success(`Agents using ${profile.name} follow it from their next turn`)
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <SettingsCard title="Access">
      <p className="border-b border-border p-3 text-muted-foreground">
        Agents using {profile.name} get this unless they choose their own. Inherited items follow the default for every
        agent.
      </p>
      <div className="p-3">
        {catalog === null ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : (
          <AccessList
            items={itemsOf(catalog, profile)}
            kinds={KINDS}
            busy={busy}
            owner={profile.name}
            onChange={(item, enabled) => void change(item, enabled)}
          />
        )}
      </div>
      <HostsRow profile={profile} onChanged={onChanged} />
    </SettingsCard>
  )
}
