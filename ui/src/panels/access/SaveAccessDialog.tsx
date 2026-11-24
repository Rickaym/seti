import type { AccessSaveChange, AccessSavePreview } from '@seti/shared'
import { Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const KIND_WORD: Record<AccessSaveChange['kind'], string> = {
  ssh: 'SSH',
  aws: 'AWS',
  mcp: 'MCP',
  pack: 'Pack',
  plugin: 'Plugin',
}

const label = (change: AccessSaveChange) => (change.kind === 'aws' ? 'AWS' : `${KIND_WORD[change.kind]} ${change.name}`)

const count = (n: number, noun: string) => `${String(n)} ${noun}${n === 1 ? '' : 's'}`

function followLine(others: number, set: string): string {
  if (others === 0) {
    return `No other agent uses ${set}.`
  }
  return `${count(others, 'other agent')} ${others === 1 ? 'uses' : 'use'} ${set} and follow it from their next turn.`
}

function ChangeLine({ change }: { change: AccessSaveChange }) {
  return (
    <li className="min-w-0 break-words">
      Turns <span className="font-medium">{label(change)}</span> {change.enabled ? 'on' : 'off'} for{' '}
      {count(change.turns.length, 'agent')}: {change.turns.join(', ')}
      {change.keeps.length > 0 && (
        <span className="text-muted-foreground"> ({change.keeps.join(', ')} keep their own choice)</span>
      )}
    </li>
  )
}

/** What saving an agent's access into its credential changes, for the user to read before Save. */
export function SaveAccessDialog({
  title,
  preview,
  busy,
  onSave,
  onClose,
}: {
  title: string
  preview: AccessSavePreview
  busy: boolean
  onSave: () => void
  onClose: () => void
}) {
  const set = preview.profile.name
  const reaching = preview.changes.filter((change) => change.turns.length > 0)
  const quiet = preview.changes.length - reaching.length
  const own = preview.own_cleared + preview.own_hosts_cleared
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent
        className="flex max-h-[85dvh] flex-col gap-3 overflow-hidden sm:max-w-lg"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle className="truncate">Save access to {set}</DialogTitle>
          <p className="text-sm text-muted-foreground">{followLine(preview.agents.length, set)}</p>
        </DialogHeader>
        <div className="-mx-4 min-h-0 flex-1 overflow-y-auto px-4 text-sm">
          <ul aria-label="What changes" className="flex flex-col gap-1.5">
            {reaching.map((change) => (
              <ChangeLine key={`${change.kind}:${change.id}`} change={change} />
            ))}
            {preview.hosts_added.map((host) => (
              <li key={host} className="min-w-0 break-words">
                Adds host <span className="font-mono">{host}</span> for every agent using {set}
              </li>
            ))}
            {quiet > 0 && (
              <li className="text-muted-foreground">
                {count(quiet, 'more item')} saved as they are now; no agent changes.
              </li>
            )}
            {own > 0 && (
              <li className="text-muted-foreground">
                {title}&apos;s {count(own, 'own choice')} {own === 1 ? 'is' : 'are'} cleared; it follows {set}.
              </li>
            )}
          </ul>
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={onSave}>
            <Upload />
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
