import type { ChannelSecret } from '@seti/shared'
import { Check } from 'lucide-react'
import { CopyButton } from '@/components/CopyButton'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { hookUrl } from './hook-url'

/** Shows a new or rotated webhook secret; Seti keeps no way to show it again. */
export function SecretDialog({ created, onClose }: { created: ChannelSecret | null; onClose: () => void }) {
  return (
    <Dialog
      open={created !== null}
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      {created !== null && (
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{created.channel.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <div className="font-medium">URL</div>
              <div className="flex items-center gap-1">
                <code className="min-w-0 flex-1 break-all" data-testid="webhook-url">
                  {hookUrl(created.channel)}
                </code>
                <CopyButton text={hookUrl(created.channel)} label="URL" />
              </div>
            </div>
            {created.secret === null ? (
              <p className="text-muted-foreground">
                {created.channel.sender.label} issued the secret, so Seti does not show it.
              </p>
            ) : (
              <div>
                <div className="font-medium">Secret</div>
                <div className="flex items-center gap-1">
                  <code className="min-w-0 flex-1 break-all" data-testid="webhook-secret">
                    {created.secret}
                  </code>
                  <CopyButton text={created.secret} label="Secret" />
                </div>
                <p className="mt-1 text-warning-text">Copy it now: Seti shows it only this once.</p>
              </div>
            )}
            <p>{created.channel.sender.setup}</p>
          </div>
          <DialogFooter>
            <Button onClick={onClose}>
              <Check />
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}
