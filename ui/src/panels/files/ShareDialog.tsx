import {
  SHARE_EXPIRY_DAYS,
  type FileShare,
  type Share,
  type ShareExpiryDays,
  type ShareFinding,
  type ShareLink,
  type ShareScanRefusal,
} from '@seti/shared'
import { Link2, Link2Off, RefreshCw, Share2, ShieldAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { apiDelete, apiGet, apiPost, errorText, RequestError } from '@/api'
import { CopyIconButton } from '@/components/CopyButton'
import { Hint } from '@/components/Hint'
import { RelativeTime } from '@/components/RelativeTime'
import { SettingsLink } from '@/components/SettingsLink'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useBusy } from '@/hooks/useBusy'
import { useNow } from '@/hooks/useNow'
import { durationLabel } from '@/lib/time'
import { LinkPreviewSwitch, PreviewFact, ShareLinkPreview, UnfurlFact } from './SharePreview'
import { shareDiagrams } from './share-diagrams'

interface ShareTarget {
  taskId: string
  root: string
  path: string
  name: string
}

const MINUTE_MS = 60_000
/** How long the browser may take to read the file and draw its diagrams for the page. */
const DRAW_MS = 30_000

const EXPIRY_LABEL: Record<ShareExpiryDays, string> = { 1: '1 day', 7: '7 days', 30: '30 days' }

/** The secret scan's findings when a request was refused for them, else null. */
function findingsOf(e: unknown): ShareFinding[] | null {
  if (!(e instanceof RequestError) || e.status !== 409) {
    return null
  }
  const body = e.body as Partial<ShareScanRefusal> | null
  return Array.isArray(body?.findings) ? body.findings : null
}

function ExpiryChoice({ value, onChange }: { value: ShareExpiryDays; onChange: (days: ShareExpiryDays) => void }) {
  return (
    <div role="group" aria-label="Expires after" className="flex gap-1.5">
      {SHARE_EXPIRY_DAYS.map((days) => (
        <Button
          key={days}
          size="sm"
          variant="outline"
          aria-pressed={value === days}
          className="flex-1 aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary"
          onClick={() => {
            onChange(days)
          }}
        >
          {EXPIRY_LABEL[days]}
        </Button>
      ))}
    </div>
  )
}

/** The link, shown once: Seti keeps only its hash. */
function LinkOnce({ url }: { url: string }) {
  return (
    <div className="space-y-1.5" data-testid="share-link">
      <div className="flex items-center gap-1.5">
        <Input
          readOnly
          aria-label="Share link"
          value={url}
          className="font-mono text-xs"
          onFocus={(e) => {
            e.target.select()
          }}
        />
        <CopyIconButton text={url} label="Copy link" variant="outline" />
      </div>
      <p className="text-xs text-muted-foreground">
        Copy it now. Seti keeps no copy of the link and cannot show it again.
      </p>
    </div>
  )
}

function Findings({ findings, busy, onAnyway }: { findings: ShareFinding[]; busy: boolean; onAnyway: () => void }) {
  return (
    <div className="space-y-2" role="alert">
      <p className="flex items-center gap-1.5 font-medium">
        <ShieldAlert className="size-4 shrink-0" />
        This file looks like it holds secrets
      </p>
      <ul className="space-y-0.5 text-xs text-muted-foreground" aria-label="Findings">
        {findings.map((finding) => (
          <li key={`${String(finding.line)} ${finding.kind}`}>
            Line {finding.line}: {finding.kind}
          </li>
        ))}
      </ul>
      <Button size="sm" variant="destructive" disabled={busy} onClick={onAnyway}>
        <Share2 />
        Share anyway
      </Button>
    </div>
  )
}

function ShareFacts({ share }: { share: Share }) {
  const now = useNow(true, MINUTE_MS)
  const last = share.recent_views.at(0)
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" data-testid="share-facts">
      <dt className="text-muted-foreground">Expires</dt>
      <dd>in {durationLabel(Date.parse(share.expires_at) - now)}</dd>
      <dt className="text-muted-foreground">Views</dt>
      <dd>
        {share.view_count}
        {last !== undefined && (
          <>
            , last <RelativeTime iso={last.at} />
            {last.country !== null && ` from ${last.country}`}
          </>
        )}
      </dd>
      <UnfurlFact share={share} />
      <PreviewFact share={share} />
      <dt className="text-muted-foreground">Snapshot</dt>
      <dd>
        Version {share.version}, updated <RelativeTime iso={share.updated_at} />
      </dd>
    </dl>
  )
}

interface Shared {
  share: Share
  onChange: (share: Share | null, url?: string) => void
  /** A change that keeps the link on screen, such as the link preview switch. */
  onSettings: (share: Share) => void
}

/** What an open share offers: a fresh copy, a new link, or the end of it. */
function SharedActions({ share, onChange, onSettings }: Shared) {
  const confirm = useConfirm()
  const { busy, run } = useBusy()
  const [findings, setFindings] = useState<ShareFinding[] | null>(null)
  const update = async (anyway: boolean) => {
    const target = { taskId: share.task_id, root: share.root, path: share.path, name: share.name }
    const diagrams = await shareDiagrams(target, AbortSignal.timeout(DRAW_MS))
    try {
      onChange(await apiPost<Share>(`/shares/${share.id}/update`, { allow_findings: anyway, diagrams }))
      setFindings(null)
    } catch (e) {
      const found = findingsOf(e)
      if (found === null) {
        throw e
      }
      setFindings(found)
    }
  }
  const rotate = async () => {
    const message = 'Make a new link?'
    const detail = 'The current link stops working at once.'
    if (await confirm({ message, detail, confirmLabel: 'New link', icon: Link2 })) {
      await run(async () => {
        const made = await apiPost<ShareLink>(`/shares/${share.id}/rotate`, {})
        onChange(made.share, made.url)
      })
    }
  }
  const revoke = async () => {
    const message = 'Revoke this link?'
    const detail = 'Anyone who opens it gets a not found page, and Seti drops its copy of the file.'
    if (await confirm({ message, detail, confirmLabel: 'Revoke', icon: Link2Off })) {
      await run(async () => {
        await apiDelete(`/shares/${share.id}`)
        onChange(null)
      })
    }
  }
  return (
    <div className="space-y-3">
      <ShareFacts share={share} />
      <ShareLinkPreview share={share} onChange={onSettings} />
      {findings !== null && (
        <Findings findings={findings} busy={busy} onAnyway={() => void run(async () => update(true))} />
      )}
      <div className="flex flex-wrap gap-1.5">
        <Hint text="Republish this link with the file as it is now">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => update(false))}>
            <RefreshCw />
            Update
          </Button>
        </Hint>
        <Hint text="Replace the link; the current one stops working">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void rotate()}>
            <Link2 />
            New link
          </Button>
        </Hint>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void revoke()}>
          <Link2Off />
          Revoke
        </Button>
      </div>
    </div>
  )
}

/** Picks an expiry and makes the link, asking again when the secret scan flags the file. */
function CreateShare({ target, onCreated }: { target: ShareTarget; onCreated: (made: ShareLink) => void }) {
  const [days, setDays] = useState<ShareExpiryDays>(7)
  const [linkPreview, setLinkPreview] = useState(true)
  const [findings, setFindings] = useState<ShareFinding[] | null>(null)
  const { busy, run } = useBusy()
  const create = async (anyway: boolean) => {
    const body = {
      root: target.root,
      path: target.path,
      expires_in_days: days,
      allow_findings: anyway,
      link_preview: linkPreview,
      diagrams: await shareDiagrams(target, AbortSignal.timeout(DRAW_MS)),
    }
    try {
      onCreated(await apiPost<ShareLink>(`/tasks/${target.taskId}/shares`, body))
    } catch (e) {
      const found = findingsOf(e)
      if (found === null) {
        throw e
      }
      setFindings(found)
    }
  }
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground">
        Anyone with the link sees a frozen copy of this file. Seti checks it for secrets first.
      </p>
      <ExpiryChoice value={days} onChange={setDays} />
      <LinkPreviewSwitch checked={linkPreview} disabled={busy} onChange={setLinkPreview} />
      {busy && (
        <p className="text-xs text-muted-foreground">
          Making the preview; a long PDF, Office file or video takes a while.
        </p>
      )}
      {findings === null ? (
        <Button size="sm" disabled={busy} onClick={() => void run(async () => create(false))}>
          <Link2 />
          Create link
        </Button>
      ) : (
        <Findings findings={findings} busy={busy} onAnyway={() => void run(async () => create(true))} />
      )}
    </div>
  )
}

function useFileShare(target: ShareTarget) {
  const [state, setState] = useState<FileShare | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    const query = new URLSearchParams({ root: target.root, path: target.path })
    apiGet<FileShare>(`/tasks/${target.taskId}/shares?${query.toString()}`).then(setState, (e: unknown) => {
      setError(errorText(e))
    })
  }, [target.taskId, target.root, target.path])
  useEffect(load, [load])
  return { state, setState, error }
}

function ShareBody({ target }: { target: ShareTarget }) {
  const { state, setState, error } = useFileShare(target)
  const [url, setUrl] = useState<string | null>(null)
  if (state === null) {
    return (
      <p className={error === '' ? 'text-muted-foreground' : 'text-destructive'}>
        {error === '' ? 'Loading...' : error}
      </p>
    )
  }
  if (!state.enabled) {
    return (
      <p className="text-muted-foreground">
        Sharing is off. Turn it on in <SettingsLink page="sharing">Settings, Sharing</SettingsLink>.
      </p>
    )
  }
  const change = (share: Share | null, link?: string) => {
    setState({ ...state, share })
    setUrl(link ?? null)
  }
  return (
    <div className="space-y-4">
      {url !== null && <LinkOnce url={url} />}
      {state.share === null ? (
        <CreateShare
          target={target}
          onCreated={(made) => {
            change(made.share, made.url)
          }}
        />
      ) : (
        <SharedActions
          share={state.share}
          onChange={change}
          onSettings={(share) => {
            setState({ ...state, share })
          }}
        />
      )}
    </div>
  )
}

/** The Share button of the file viewer and the dialog it opens. */
export function ShareButton({ target }: { target: ShareTarget }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Hint text="Share a public link to a frozen copy">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Share"
          onClick={() => {
            setOpen(true)
          }}
        >
          <Share2 />
        </Button>
      </Hint>
      {open && (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="truncate">Share {target.name}</DialogTitle>
            </DialogHeader>
            <div className="min-w-0 text-sm">
              <ShareBody target={target} />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
