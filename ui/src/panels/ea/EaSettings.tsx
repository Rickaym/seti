import { Settings, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useNarrow } from '@/hooks/useMedia'
import { navigate } from '@/lib/route'
import { EaContextPacks, EaPacksDialog } from '@/panels/ea/EaPacks'
import { takeEaSettingsRequest, useEaSettingsRequested } from '@/panels/ea/ea-settings-store'
import { SubscribedChannels } from '@/panels/settings/channels/SubscribedChannels'
import { NewRoleDialog, RolePicker, type RoleOwner } from '@/panels/tasks/RolePicker'

const EA_ROLE: RoleOwner = { packsPath: '/ea/context-packs', rolePath: '/ea/role', name: 'EA', pinned: false }

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

function Go({ page, onGo, children }: { page: string; onGo: () => void; children: string }) {
  return (
    <button
      type="button"
      className="text-left text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary pointer-coarse:min-h-11"
      onClick={() => {
        onGo()
        navigate('settings', page)
      }}
    >
      {children}
    </button>
  )
}

/** The Add channel popover opened from the sheet leaves the sheet open behind it. */
const keepForPopovers = (e: Event) => {
  if (e.target instanceof Element && e.target.closest('[role="dialog"]') !== null) {
    e.preventDefault()
  }
}

/** The EA's role, packs and channels behind one cog: a popover, or a bottom sheet on phones. */
export function EaSettings({ touch }: { touch: boolean }) {
  const [open, setOpen] = useState(false)
  const [version, setVersion] = useState(0)
  const [packsOpen, setPacksOpen] = useState(false)
  const [newRole, setNewRole] = useState<string | null>(null)
  const narrow = useNarrow()
  const requested = useEaSettingsRequested()
  if (requested && !open) {
    setOpen(true)
  }
  useEffect(() => {
    if (requested) {
      takeEaSettingsRequest()
    }
  }, [requested])
  const close = () => {
    setOpen(false)
  }
  const changed = () => {
    setVersion((v) => v + 1)
  }
  const details = (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs" aria-label="EA settings">
      <Row label="Role">
        <RolePicker
          owner={EA_ROLE}
          focus={false}
          onChanged={changed}
          onNew={(body) => {
            close()
            setNewRole(body)
          }}
          onLeave={close}
        />
      </Row>
      <Row label="Context">
        <EaContextPacks
          version={version}
          onEdit={() => {
            close()
            setPacksOpen(true)
          }}
        />
      </Row>
      <Row label="Channels">
        <SubscribedChannels
          listPath="/ea/channels"
          subscriber={{ target: 'ea' }}
          addHint="Queue a channel's events in the EA inbox"
          testId="ea-channels"
        />
      </Row>
      <Row label="More">
        <div className="flex flex-wrap gap-x-3">
          <Go page="ea" onGo={close}>
            Voice and wake word
          </Go>
          <Go page="channels" onGo={close}>
            All channels
          </Go>
        </div>
      </Row>
    </dl>
  )
  const dialogs = (
    <>
      {newRole !== null && (
        <NewRoleDialog
          owner={EA_ROLE}
          initial={newRole}
          onChanged={changed}
          onClose={() => {
            setNewRole(null)
          }}
        />
      )}
      {packsOpen && (
        <EaPacksDialog
          onChanged={changed}
          onClose={() => {
            setPacksOpen(false)
          }}
        />
      )}
    </>
  )
  if (narrow) {
    return (
      <>
        <Button
          size={touch ? 'icon-sm' : 'icon-xs'}
          variant="ghost"
          aria-label="EA settings"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            setOpen(true)
          }}
        >
          <Settings className="size-4" />
        </Button>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="bottom"
            showCloseButton={false}
            aria-describedby={undefined}
            className="max-h-[calc(var(--app-height,100dvh)-env(safe-area-inset-top)-1.5rem)] gap-0"
            onOpenAutoFocus={(e) => {
              e.preventDefault()
            }}
            onFocusOutside={keepForPopovers}
            onPointerDownOutside={keepForPopovers}
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border py-1 pr-1 pl-4">
              <SheetTitle className="text-sm font-semibold">EA settings</SheetTitle>
              <Button variant="ghost" size="icon-sm" aria-label="Close EA settings" onClick={close}>
                <X />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">{details}</div>
          </SheetContent>
        </Sheet>
        {dialogs}
      </>
    )
  }
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Hint text="EA settings: its role, context packs and the channels it takes events from">
          <PopoverTrigger asChild>
            <Button size={touch ? 'icon-sm' : 'icon-xs'} variant="ghost" aria-label="EA settings">
              <Settings className="size-4" />
            </Button>
          </PopoverTrigger>
        </Hint>
        <PopoverContent
          align="end"
          className="max-h-(--radix-popover-content-available-height) w-96 overflow-y-auto"
          onFocusOutside={(e) => {
            e.preventDefault()
          }}
        >
          {details}
        </PopoverContent>
      </Popover>
      {dialogs}
    </>
  )
}
