import { CircleQuestionMark, Search } from 'lucide-react'
import { Fragment, type ComponentProps } from 'react'
import { Hint } from '@/components/Hint'
import { openPalette } from '@/components/palette/palette-store'
import { useRegisteredCommands } from '@/components/palette/useCommands'
import { Legend } from '@/components/shortcuts/Legend'
import { chordAria, chordLabel, CHORDS } from '@/components/shortcuts/chords'
import { guideGroups } from '@/components/shortcuts/guide'
import { openGuide, setGuideOpen, useGuideOpen } from '@/components/shortcuts/guide-store'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useCoarsePointer } from '@/hooks/useMedia'
import { useMods } from '@/hooks/useMods'

const TITLE = 'Shortcuts'

/** The keys, left out on a phone without a keyboard, then the legend of shapes and items. */
function GuideList({ keys = true }: { keys?: boolean }) {
  const commands = useRegisteredCommands()
  const mods = useMods().data?.mods ?? []
  const rows = mods.flatMap((mod) => (mod.running ? (mod.manifest?.contributes.shortcuts ?? []) : []))
  const groups = keys ? guideGroups(commands, rows) : []
  return (
    <div className="flex flex-col gap-3 font-mono text-xs">
      {groups.map((group) => (
        <section key={group.heading} aria-label={group.heading}>
          <h3 className="mb-1 text-2xs tracking-wider text-muted-foreground uppercase">{group.heading}</h3>
          <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1">
            {group.rows.map((row) => (
              <Fragment key={row.keys}>
                <dt>
                  <kbd>{row.keys}</kbd>
                </dt>
                <dd className="text-muted-foreground">{row.action}</dd>
              </Fragment>
            ))}
          </dl>
        </section>
      ))}
      <Legend />
    </div>
  )
}

function GuideButton(props: ComponentProps<typeof Button>) {
  return (
    <Button variant="ghost" size="icon" aria-label={TITLE} aria-keyshortcuts={chordAria(CHORDS.guide)} {...props}>
      <CircleQuestionMark />
    </Button>
  )
}

/** The sidebar rail's guide button, which opens the guide beside it. */
export function ShortcutGuidePopover({ className }: { className?: string }) {
  const open = useGuideOpen()
  return (
    <Popover open={open} onOpenChange={setGuideOpen}>
      <Hint text={`${TITLE} (${chordLabel(CHORDS.guide)})`} side="right">
        <PopoverTrigger asChild>
          <GuideButton className={className} />
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        side="right"
        align="end"
        aria-label={TITLE}
        className="max-h-(--radix-popover-content-available-height) w-96 overflow-y-auto"
      >
        <GuideList />
      </PopoverContent>
    </Popover>
  )
}

/** Opens the guide as a sheet, from the phone menu drawer. */
export function ShortcutGuideOpener({ className, onOpen }: { className?: string; onOpen: () => void }) {
  return (
    <GuideButton
      className={className}
      onClick={() => {
        onOpen()
        openGuide()
      }}
    />
  )
}

/** The guide when no rail shows; phones, which lack a keyboard, also get a way into the palette. */
export function ShortcutGuideSheet({ narrow }: { narrow: boolean }) {
  const open = useGuideOpen()
  const touch = useCoarsePointer()
  return (
    <Sheet open={open} onOpenChange={setGuideOpen}>
      <SheetContent side="bottom" className="max-h-[85dvh] gap-3 overflow-y-auto p-4 md:mx-auto md:max-w-md">
        <SheetTitle>{TITLE}</SheetTitle>
        <SheetDescription className="sr-only">Keys, status shapes and status bar items</SheetDescription>
        {narrow && (
          <Button
            variant="outline"
            className="justify-start"
            onClick={() => {
              setGuideOpen(false)
              openPalette()
            }}
          >
            <Search />
            Open command palette
          </Button>
        )}
        <GuideList keys={!(narrow && touch)} />
      </SheetContent>
    </Sheet>
  )
}
