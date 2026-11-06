import type { AuditActorFilter, AuditStatus } from '@seti/shared'
import { ChevronsDown, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet } from '@/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { startPolling } from '@/lib/poll-loop'
import { navigate } from '@/lib/route'
import { AuditFilters } from '@/panels/audit/AuditFilters'
import { AuditTable } from '@/panels/audit/AuditTable'
import { ChainBadge } from '@/panels/audit/ChainBadge'
import { isArea } from '@/panels/audit/format'
import { useAuditLog } from '@/panels/audit/useAuditLog'
import { SettingsBody, SettingsHeader } from './layout'

const POLL_MS = 10_000
const SEARCH_DELAY_MS = 300
const TOP_SLACK_PX = 16

/** Retention and chain verification, loaded with the page and on each manual refresh. */
function useAuditStatus() {
  const [status, setStatus] = useState<AuditStatus | null>(null)
  const load = useCallback(() => {
    apiGet<AuditStatus>('/audit/status')
      .then(setStatus)
      .catch(() => {
        setStatus(null)
      })
  }, [])
  useEffect(load, [load])
  return { status, reload: load }
}

function describeLog(status: AuditStatus | null): string {
  const kept = status === null ? '' : ` Kept for ${String(status.retention_days)} days.`
  return `Who or what did what in Seti, newest first: you, agents, the EA and the server.${kept}`
}

/** The audit log; `area` comes from `#settings/audit/<area>` so a filtered view can be linked. */
export function AuditPage({ area: routeArea }: { area: string | null }) {
  const area = routeArea !== null && isArea(routeArea) ? routeArea : null
  const [actor, setActor] = useState<AuditActorFilter | null>(null)
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [now, setNow] = useState(Date.now)
  const scroller = useRef<HTMLDivElement>(null)
  const { events, error, loading, hasOlder, loadingOlder, refresh, loadOlder } = useAuditLog({ area, actor, q })
  const { status, reload } = useAuditStatus()

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(search)
    }, SEARCH_DELAY_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [search])

  useEffect(
    () =>
      startPolling(() => {
        setNow(Date.now())
        if ((scroller.current?.scrollTop ?? 0) <= TOP_SLACK_PX) {
          refresh()
        }
      }, POLL_MS),
    [refresh],
  )

  const filtered = area !== null || actor !== null || q.trim() !== ''
  const emptyText = filtered ? 'No events match these filters.' : 'Nothing recorded yet.'

  return (
    <SettingsBody
      scrollRef={scroller}
      header={
        <SettingsHeader
          title="Audit log"
          description={describeLog(status)}
          actions={
            <>
              <ChainBadge status={status} />
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setNow(Date.now())
                  refresh()
                  reload()
                }}
              >
                <RefreshCw />
                Refresh
              </Button>
            </>
          }
        />
      }
    >
      <div className="space-y-4">
        <AuditFilters
          area={area}
          actor={actor}
          search={search}
          onArea={(next) => {
            navigate('settings', next === null ? 'audit' : `audit/${next}`)
          }}
          onActor={setActor}
          onSearch={setSearch}
        />
        {error !== '' && (
          <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        <Card className="gap-0 py-0">
          <CardContent className="p-0">
            {events.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground">{loading ? 'Loading...' : emptyText}</p>
            ) : (
              <AuditTable events={events} now={now} />
            )}
          </CardContent>
        </Card>
        {events.length > 0 && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {events.length} {events.length === 1 ? 'event' : 'events'} shown{hasOlder ? '' : ', nothing older'}
            </span>
            {hasOlder && (
              <Button variant="outline" size="sm" onClick={loadOlder} disabled={loadingOlder}>
                <ChevronsDown />
                {loadingOlder ? 'Loading...' : 'Load older'}
              </Button>
            )}
          </div>
        )}
      </div>
    </SettingsBody>
  )
}
