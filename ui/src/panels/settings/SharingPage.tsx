import type { Share, ShareList } from '@seti/shared'
import { Link2Off } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { apiDelete, apiGet, apiPost, apiPut, errorText } from '@/api'
import { RelativeTime } from '@/components/RelativeTime'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { Switch } from '@/components/ui/switch'
import { useBusy } from '@/hooks/useBusy'
import { useNow } from '@/hooks/useNow'
import { unfurlerNames } from '@/lib/share-views'
import { durationLabel } from '@/lib/time'
import { SettingRow, SettingsBody, SettingsCard, SettingsHeader } from './layout'

const ROW = 'flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0 max-md:flex-wrap'
const NOW_TICK_MS = 60_000

const isOpen = (share: Share, now: number) => share.revoked_at === null && Date.parse(share.expires_at) > now

function ShareRow({ share, now, onChange }: { share: Share; now: number; onChange: () => void }) {
  const open = isOpen(share, now)
  const confirm = useConfirm()
  const { busy, run } = useBusy()
  const lastCountry = share.recent_views.at(0)?.country ?? null
  const revoke = async () => {
    const message = `Revoke the link to ${share.name}?`
    const detail = 'Anyone who opens it gets a not found page, and Seti drops its copy of the file.'
    if (await confirm({ message, detail, confirmLabel: 'Revoke', icon: Link2Off })) {
      if (await run(async () => apiDelete(`/shares/${share.id}`))) {
        onChange()
      }
    }
  }
  return (
    <div className={ROW} data-testid="share-row" data-open={open ? '' : undefined}>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-sm" title={share.path}>
          {share.path}
        </span>
        <span className="text-muted-foreground">
          {share.task_title}, shared <RelativeTime iso={share.created_at} />,{' '}
          {share.revoked_at === null ? (
            <>
              {open ? (
                `expires in ${durationLabel(Date.parse(share.expires_at) - now)}`
              ) : (
                <>
                  expired <RelativeTime iso={share.expires_at} />
                </>
              )}
            </>
          ) : (
            <>
              revoked <RelativeTime iso={share.revoked_at} />
            </>
          )}
          , {share.view_count} {share.view_count === 1 ? 'view' : 'views'}
          {lastCountry !== null && `, last from ${lastCountry}`}
          {share.unfurl_count > 0 && (
            <span data-testid="share-row-unfurls">
              , {share.unfurl_count} link {share.unfurl_count === 1 ? 'preview' : 'previews'} by{' '}
              {unfurlerNames(share.recent_unfurls)}
            </span>
          )}
        </span>
      </div>
      {open && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revoke()}>
          <Link2Off />
          Revoke
        </Button>
      )}
    </div>
  )
}

function SharesCard({ list, onChange }: { list: ShareList; onChange: () => void }) {
  const confirm = useConfirm()
  const { busy, run } = useBusy()
  const now = useNow(true, NOW_TICK_MS)
  const openCount = list.shares.filter((share) => isOpen(share, now)).length
  const revokeAll = async () => {
    const message = `Revoke all ${String(openCount)} open links?`
    const detail = 'Every link shows a not found page at once, and Seti drops its copies of the files.'
    if (await confirm({ message, detail, confirmLabel: 'Revoke all', icon: Link2Off })) {
      if (await run(async () => apiPost('/shares/revoke-all', {}))) {
        onChange()
      }
    }
  }
  return (
    <SettingsCard
      title="Shared files"
      actions={
        openCount > 0 && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void revokeAll()}>
            <Link2Off />
            Revoke all
          </Button>
        )
      }
    >
      {list.shares.length === 0 ? (
        <p className="px-3 py-3 text-muted-foreground">
          No file is shared. Open a file in an agent's Files and use Share to make a link.
        </p>
      ) : (
        list.shares.map((share) => <ShareRow key={share.id} share={share} now={now} onChange={onChange} />)
      )}
    </SettingsCard>
  )
}

export function SharingPage() {
  const [list, setList] = useState<ShareList | null>(null)
  const [error, setError] = useState('')
  const { busy, run } = useBusy()
  const load = useCallback(() => {
    apiGet<ShareList>('/shares').then(setList, (e: unknown) => {
      setError(errorText(e))
    })
  }, [])
  useEffect(load, [load])
  const toggle = async (enabled: boolean) => {
    await run(async () => {
      setList(await apiPut<ShareList>('/shares/settings', { enabled }))
    })
  }
  return (
    <SettingsBody
      narrow
      header={
        <SettingsHeader
          title="Sharing"
          description="Public links to a frozen copy of one file. Anyone with a link sees that copy until it expires or you revoke it."
        />
      }
    >
      {list === null ? (
        <p className={error === '' ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>
          {error === '' ? 'Loading...' : error}
        </p>
      ) : (
        <div className="space-y-4">
          <SettingsCard title="Public links">
            <SettingRow
              label="Allow sharing"
              description="While off, Seti makes no new links and every link shows a not found page. Only you change this."
            >
              <Switch
                aria-label="Allow sharing"
                checked={list.enabled}
                disabled={busy}
                onCheckedChange={(enabled) => void toggle(enabled)}
              />
            </SettingRow>
          </SettingsCard>
          <SharesCard list={list} onChange={load} />
        </div>
      )}
    </SettingsBody>
  )
}
