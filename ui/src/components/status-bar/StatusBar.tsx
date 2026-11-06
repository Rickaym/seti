import type { ReactNode } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ScrollFade } from '@/components/ScrollFade'
import { HealthItem } from '@/components/status-bar/HealthItem'
import { useStatusItems } from '@/components/status-bar/items'
import { useNarrow } from '@/hooks/useMedia'

/** One item, so a crash in it leaves a reload button in its slot and the rest of the bar works. */
function Item({ name, children }: { name: string; children: ReactNode }) {
  return (
    <ErrorBoundary kind="item" name={name}>
      {children}
    </ErrorBoundary>
  )
}

/** Every registered item of one slot, each in its own error boundary. */
function SlotItems({ slot }: { slot: 'work' | 'account' | 'health' }) {
  return (
    <>
      {useStatusItems(slot).map(({ key, name, view: View }) => (
        <Item key={key} name={name}>
          <View />
        </Item>
      ))}
    </>
  )
}

/** Bottom bar: work that needs a look on the left; plan usage, then health past a hairline. */
export function StatusBar() {
  const narrow = useNarrow()
  const items = (
    <>
      <div role="group" aria-label="Work" className="flex min-w-0 items-stretch max-md:shrink-0">
        <SlotItems slot="work" />
      </div>
      <div className="flex min-w-0 items-stretch max-md:shrink-0">
        <SlotItems slot="account" />
        <div role="group" aria-label="Health" className="flex min-w-0 items-stretch border-l border-border">
          {narrow ? (
            <Item name="Health">
              <HealthItem>
                <SlotItems slot="health" />
              </HealthItem>
            </Item>
          ) : (
            <SlotItems slot="health" />
          )}
        </div>
      </div>
    </>
  )
  return (
    <footer className="box-content flex h-6 shrink-0 items-stretch justify-between border-t border-border bg-muted text-2xs select-none pointer-coarse:h-11 pointer-coarse:pb-[env(safe-area-inset-bottom)] pointer-coarse:text-xs max-md:overflow-hidden typing:hidden agent-room:hidden">
      {narrow ? (
        <ScrollFade className="flex min-w-0 flex-1 items-stretch justify-between gap-2 [scrollbar-width:none]">
          {items}
        </ScrollFade>
      ) : (
        items
      )}
    </footer>
  )
}
