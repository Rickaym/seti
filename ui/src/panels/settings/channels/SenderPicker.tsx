import { CORE_WEBHOOK_SOURCE, type WebhookSourceInfo } from '@seti/shared'
import { Search, SlidersHorizontal, Webhook } from 'lucide-react'
import { useState } from 'react'
import { Hint } from '@/components/Hint'
import { ServiceIcon } from '@/components/service-icon/ServiceIcon'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

const matches = (sender: WebhookSourceInfo, query: string) =>
  query === '' || `${sender.label} ${sender.description} ${sender.signature}`.toLowerCase().includes(query)

/** Apps by name, with Seti's own signature last: the fallback for a sender that can use it. */
const ordered = (senders: readonly WebhookSourceInfo[]) => [
  ...senders.filter((sender) => sender.id !== CORE_WEBHOOK_SOURCE).sort((a, b) => a.label.localeCompare(b.label)),
  ...senders.filter((sender) => sender.id === CORE_WEBHOOK_SOURCE),
]

function SenderRow({ sender, onPick }: { sender: WebhookSourceInfo; onPick: () => void }) {
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        aria-label={sender.label}
        onClick={onPick}
        className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-accent pointer-coarse:min-h-11"
      >
        <ServiceIcon icon={sender.icon} fallback={Webhook} className="mt-0.5" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{sender.label}</span>
          <span className="line-clamp-2 text-muted-foreground">{sender.description}</span>
          <span className="truncate font-mono text-2xs text-muted-foreground">{sender.signature}</span>
        </span>
      </button>
    </li>
  )
}

/** Picks the app that will send to a new webhook, or the custom form for one Seti does not list. */
export function SenderPicker({
  senders,
  onClose,
  onPick,
  onCustom,
}: {
  senders: readonly WebhookSourceInfo[]
  onClose: () => void
  onPick: (sender: WebhookSourceInfo) => void
  onCustom: () => void
}) {
  const [query, setQuery] = useState('')
  const found = ordered(senders).filter((sender) => matches(sender, query.trim().toLowerCase()))
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent className="flex max-h-[92vh] min-h-0 flex-col gap-0 overflow-hidden border p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle>New webhook</DialogTitle>
        </DialogHeader>
        <div className="relative border-b border-border px-4 py-2">
          <Search className="pointer-events-none absolute top-1/2 left-6 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search senders"
            placeholder="Search apps"
            value={query}
            className="pl-7"
            onChange={(event) => {
              setQuery(event.target.value)
            }}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto text-xs">
          {found.length === 0 ? (
            <p className="px-3 py-4 text-muted-foreground">Nothing matches. Describe the app as a custom sender.</p>
          ) : (
            <ul aria-label="Senders">
              {found.map((sender) => (
                <SenderRow
                  key={sender.id}
                  sender={sender}
                  onPick={() => {
                    onPick(sender)
                  }}
                />
              ))}
            </ul>
          )}
        </div>
        <DialogFooter className="border-t border-border px-4 py-3">
          <Hint text="Describe how an app Seti does not list signs its requests">
            <Button type="button" variant="outline" size="sm" onClick={onCustom}>
              <SlidersHorizontal />
              Custom
            </Button>
          </Hint>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
