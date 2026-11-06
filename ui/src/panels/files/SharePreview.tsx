import type { Share } from '@seti/shared'
import { useId } from 'react'
import { apiPut } from '@/api'
import { RelativeTime } from '@/components/RelativeTime'
import { Switch } from '@/components/ui/switch'
import { useBusy } from '@/hooks/useBusy'
import { unfurlerNames } from '@/lib/share-views'

/** What the share page shows, such as "PDF, 12 pages, first 50 pages shown". */
function previewText(share: Share): string {
  const { label, note } = share.preview
  return [label, note].filter((part) => part !== null && part !== '').join(', ')
}

/** The preview row of the share facts, with the converter's message when one failed. */
export function PreviewFact({ share }: { share: Share }) {
  const text = previewText(share)
  if (text === '' && share.preview.error === null) {
    return null
  }
  return (
    <>
      <dt className="text-muted-foreground">Preview</dt>
      <dd data-testid="share-preview">
        {text}
        {share.preview.error !== null && (
          <span className="block text-muted-foreground" role="status">
            {share.preview.error}. The page offers the download instead.
          </span>
        )}
      </dd>
    </>
  )
}

/** How often chat apps fetched the link for a card; these are not counted as views. */
export function UnfurlFact({ share }: { share: Share }) {
  const last = share.recent_unfurls.at(0)
  if (share.unfurl_count === 0 || last === undefined) {
    return null
  }
  return (
    <>
      <dt className="text-muted-foreground">Link previews</dt>
      <dd data-testid="share-unfurls">
        {share.unfurl_count} by {unfurlerNames(share.recent_unfurls)}, last <RelativeTime iso={last.at} />
      </dd>
    </>
  )
}

interface ToggleProps {
  checked: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
}

/** The link preview switch: on, chat apps show the name, kind, size and a thumbnail. */
export function LinkPreviewSwitch({ checked, disabled = false, onChange }: ToggleProps) {
  const id = useId()
  return (
    <div className="flex items-start gap-2">
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-0.5" />
      <label htmlFor={id} className="grid gap-0.5">
        <span>Link preview</span>
        <span className="text-xs text-muted-foreground">
          Chat apps show the name, kind, size and a thumbnail. Off, they show the name only.
        </span>
      </label>
    </div>
  )
}

/** The switch for a share that exists, saved as soon as it changes. */
export function ShareLinkPreview({ share, onChange }: { share: Share; onChange: (share: Share) => void }) {
  const { busy, run } = useBusy()
  const set = (on: boolean) =>
    void run(async () => {
      onChange(await apiPut<Share>(`/shares/${share.id}/link-preview`, { link_preview: on }))
    })
  return <LinkPreviewSwitch checked={share.link_preview} disabled={busy} onChange={set} />
}
