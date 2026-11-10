import { useId } from 'react'
import { NewsDot } from '@/components/NewsDot'
import { WaitingCount } from '@/components/WaitingCount'
import { ShortcutGuidePopover } from '@/components/shortcuts/ShortcutGuide'
import { chordAria, chordLabel, sectionChord } from '@/components/shortcuts/chords'
import { TeamChatToggle } from '@/components/team/TeamChatToggle'
import { ModeToggle } from '@/components/theme/mode-toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useKnowledgeWaiting } from '@/hooks/useKnowledgeWaiting'
import { describedBy } from '@/lib/described-by'
import { useNewsPages } from '@/lib/mod-views'
import { useSectionGroups, type SectionKey } from '@/lib/sections'
import { cn } from '@/lib/utils'
import { TerminalNavButton } from '@/panels/terminal/TerminalNavButton'

export function Sidebar({ active, onSelect }: { active: SectionKey; onSelect: (key: SectionKey) => void }) {
  const news = useNewsPages().length > 0
  const newsId = useId()
  const waitingId = useId()
  const waiting = useKnowledgeWaiting()
  const groups = useSectionGroups()
  return (
    <aside aria-label="Sidebar" className="flex min-h-0 w-12 shrink-0 flex-col border-r border-border bg-card">
      <nav className="flex flex-1 flex-col items-center gap-1 overflow-y-auto py-2" aria-label="Sections">
        {groups.map((group, index) => (
          <div
            key={group.group}
            role="group"
            aria-label={group.group}
            className={cn('flex flex-col items-center gap-1', index > 0 && 'mt-1 border-t border-border pt-2')}
          >
            {group.items.map((item) => {
              const Icon = item.icon
              const current = active === item.key
              const chord = item.digit === null ? null : sectionChord(item.digit)
              const dot = news && item.key === 'settings'
              const count = item.key === 'context' ? waiting : 0
              return (
                <Tooltip key={item.key}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={item.label}
                      aria-current={current ? 'page' : undefined}
                      aria-keyshortcuts={chord === null ? undefined : chordAria(chord)}
                      aria-describedby={describedBy(dot && newsId, count > 0 && waitingId)}
                      onClick={() => {
                        onSelect(item.key)
                      }}
                      className={cn(
                        'relative flex size-9 items-center justify-center rounded-none transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        current
                          ? 'bg-primary text-primary-foreground'
                          : 'text-foreground/70 hover:bg-accent hover:text-accent-foreground',
                      )}
                    >
                      <Icon className="size-[18px]" />
                      {dot && (
                        <NewsDot
                          id={newsId}
                          className={cn('absolute top-1 right-1', current && 'bg-primary-foreground')}
                        />
                      )}
                      {count > 0 && <WaitingCount count={count} id={waitingId} className="translate-x-0" />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {item.label}
                    {chord !== null && <kbd className="ml-2 font-mono opacity-70">{chordLabel(chord)}</kbd>}
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        ))}
      </nav>
      <div className="flex shrink-0 flex-col items-center gap-1 border-t border-border py-2">
        <TerminalNavButton side="right" className="size-9 text-foreground/70" />
        <TeamChatToggle side="right" className="size-9 text-foreground/70" />
        <ModeToggle side="right" className="size-9 text-foreground/70" />
        <ShortcutGuidePopover className="size-9 text-foreground/70" />
      </div>
    </aside>
  )
}
