import { Menu, X } from 'lucide-react'
import { useEffect, useId, useMemo } from 'react'
import { NewsDot } from '@/components/NewsDot'
import { ShortcutGuideOpener } from '@/components/shortcuts/ShortcutGuide'
import { ModeToggle } from '@/components/theme/mode-toggle'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useNarrow } from '@/hooks/useMedia'
import { useNewsPages } from '@/lib/mod-views'
import { useSectionGroups, type SectionKey } from '@/lib/sections'
import { ownsSwipeRight, swipeTracker } from '@/lib/swipe'
import { cn } from '@/lib/utils'
import { TerminalDrawerItem } from '@/panels/terminal/TerminalNavButton'

interface NavDrawerProps {
  active: SectionKey
  onSelect: (key: SectionKey) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** A swipe right on a narrow screen opens the drawer, unless the touch belongs to its target. */
function useSwipeToOpen(enabled: boolean, setOpen: (open: boolean) => void) {
  useEffect(() => {
    if (!enabled) {
      return
    }
    const tracker = swipeTracker(
      'right',
      () => {
        setOpen(true)
      },
      (event) => document.body.hasAttribute('data-scroll-locked') || ownsSwipeRight(event.target),
    )
    document.addEventListener('touchstart', tracker.start, { passive: true })
    document.addEventListener('touchend', tracker.end, { passive: true })
    document.addEventListener('touchcancel', tracker.cancel, { passive: true })
    return () => {
      document.removeEventListener('touchstart', tracker.start)
      document.removeEventListener('touchend', tracker.end)
      document.removeEventListener('touchcancel', tracker.cancel)
    }
  }, [enabled, setOpen])
}

/** The sidebar below md: a menu button in the header opens the sections as a drawer. */
export function NavDrawer({ active, onSelect, open, onOpenChange: setOpen }: NavDrawerProps) {
  const news = useNewsPages().length > 0
  const newsId = useId()
  const settingsNewsId = useId()
  const groups = useSectionGroups()
  useSwipeToOpen(useNarrow() && !open, setOpen)
  const swipeClose = useMemo(
    () =>
      swipeTracker(
        'left',
        () => {
          setOpen(false)
        },
        () => false,
      ),
    [setOpen],
  )
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="relative -ml-2 md:hidden"
        aria-label="Menu"
        aria-describedby={news ? newsId : undefined}
        aria-expanded={open}
        onClick={() => {
          setOpen(true)
        }}
      >
        <Menu />
        {news && <NewsDot id={newsId} className="absolute top-2 right-2" />}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="w-64 gap-0"
          onTouchStart={swipeClose.start}
          onTouchEnd={swipeClose.end}
          onTouchCancel={swipeClose.cancel}
        >
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-border pr-2 pl-4">
            <SheetTitle className="text-sm font-semibold tracking-[0.3em]">SETI</SheetTitle>
            <SheetDescription className="sr-only">Sections</SheetDescription>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close"
              onClick={() => {
                setOpen(false)
              }}
            >
              <X />
            </Button>
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto py-2" aria-label="Sections">
            {groups.map((group, index) => (
              <div
                key={group.group}
                role="group"
                aria-label={group.group}
                className={cn('flex flex-col', index > 0 && 'mt-2 border-t border-border pt-2')}
              >
                {group.items.map((item) => {
                  const Icon = item.icon
                  const current = active === item.key
                  const dot = news && item.key === 'settings'
                  return (
                    <button
                      key={item.key}
                      type="button"
                      aria-current={current ? 'page' : undefined}
                      aria-describedby={dot ? settingsNewsId : undefined}
                      onClick={() => {
                        setOpen(false)
                        onSelect(item.key)
                      }}
                      className={cn(
                        'flex min-h-11 items-center gap-3 px-4 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        current ? 'bg-primary text-primary-foreground' : 'text-foreground/80 hover:bg-accent',
                      )}
                    >
                      <Icon className="size-[18px] shrink-0" />
                      <span className="flex-1">{item.label}</span>
                      {dot && <NewsDot id={settingsNewsId} className={cn(current && 'bg-primary-foreground')} />}
                    </button>
                  )
                })}
              </div>
            ))}
          </nav>
          <div className="shrink-0 border-t border-border py-2">
            <TerminalDrawerItem
              onOpen={() => {
                setOpen(false)
              }}
            />
          </div>
          <div className="flex shrink-0 items-center justify-between border-t border-border px-2 py-2">
            <ShortcutGuideOpener
              onOpen={() => {
                setOpen(false)
              }}
            />
            <ModeToggle />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
