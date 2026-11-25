import { ArrowRightLeft, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { PickConsequence } from './pick-consequence'

const items = (n: number, noun: string) => `${String(n)} ${noun}${n === 1 ? '' : 's'}`

function Turns({ label, names }: { label: string; names: string[] }) {
  return names.length === 0 ? null : (
    <p className="min-w-0 break-words">
      <span className="font-medium">{label}:</span> {names.join(', ')}
    </p>
  )
}

/** The consequence of picking a credential whose access set its agents follow, before the switch. */
export function PickCredentialDialog({
  title,
  pick,
  onPick,
  onClose,
}: {
  title: string
  pick: PickConsequence
  onPick: (reset: boolean) => void
  onClose: () => void
}) {
  const { profile, own, on, off } = pick
  const stay = own === 1 ? 'stays' : 'stay'
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent className="flex max-h-[85dvh] flex-col gap-3 sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="truncate">Use {profile.name}</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto text-sm">
          <p>
            {title} follows {profile.name}&apos;s access from the next turn.
          </p>
          <Turns label="Turns on" names={on} />
          <Turns label="Turns off" names={off} />
          {on.length + off.length === 0 && <p className="text-muted-foreground">Nothing changes now.</p>}
          {own > 0 && (
            <p className="text-muted-foreground">
              Its {items(own, 'own choice')} {stay} unless you reset.
            </p>
          )}
        </div>
        <DialogFooter className="shrink-0 gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {own > 0 && (
            <Button
              variant="outline"
              onClick={() => {
                onPick(true)
              }}
            >
              <RotateCcw />
              Reset own
            </Button>
          )}
          <Button
            onClick={() => {
              onPick(false)
            }}
          >
            <ArrowRightLeft />
            Switch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
